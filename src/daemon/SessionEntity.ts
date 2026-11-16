import { createHash } from "node:crypto"
import { resolve } from "node:path"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import type { Task, TaskHandle } from "clanka/AgentTools"
import * as McpServers from "clanka/McpServers"
import { DiscordChat } from "@effect/chat-discord"
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  MutableRef,
  Option,
  PrimaryKey,
  Schema,
  Scope,
  Stream,
} from "effect"
import { Prompt } from "effect/ai"
import { ChatEvent, ChatMessage, ChatThread } from "effect/chat"
import { ClusterSchema, Entity, type Sharding } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { SqlClient } from "effect/sql"
import * as Messages from "../Messages.ts"
import * as PublicSession from "../Session.ts"
import { Timings } from "../Timings.ts"
import * as Attachments from "./Attachments.ts"
import { Chats, type ChatService } from "./Chats.ts"
import * as Disk from "./Disk.ts"
import * as Failed from "./Failed.ts"
import type { Format } from "./Format.ts"
import * as Logger from "./Logger.ts"
import * as Login from "./Login.ts"
import * as Model from "./Model.ts"
import * as Notices from "./Notices.ts"
import * as PersonaFile from "./Persona.ts"
import { Plugins } from "./Plugins.ts"
import * as Post from "./Post.ts"
import * as Queue from "./Queue.ts"
import * as Sessions from "./Sessions.ts"
import * as StatusMessage from "./StatusMessage.ts"
import * as Spawner from "./Spawner.ts"
import * as TurnLog from "./TurnLog.ts"
import { Volume } from "./Volume.ts"

const ChatMessageJson = Schema.toCodecJson(ChatMessage.ChatMessage)
const encodeChatMessage = Schema.encodeSync(ChatMessageJson)
const decodeChatMessage = Schema.decodeUnknownExit(ChatMessageJson)

/**
 * An owner's message, as the request cluster persists. Its primary key is the event's dedupe key, so an event that is
 * delivered again is dropped while cluster still holds the request.
 */
export class Message extends Schema.Class<Message>("chad/Session/Message")({
  key: Schema.String,
  /** The name of the chat connection the message arrived on, which is the one the session answers through. */
  connection: Schema.String,
  /**
   * The whole chat message, in effect/chat's own encoded form. The entity decodes it itself, so that a stored message
   * a later image no longer reads still ends its request with a message in the thread (SES-152). The stored bytes are
   * the ones a `ChatMessage` field gave.
   */
  message: Schema.Json,
  attachments: Schema.Array(Schema.String),
}) {
  static fromEvent(event: ChatEvent.MessageCreated, connection: string) {
    return new Message({
      key: ChatEvent.dedupeKey(event),
      connection,
      message: encodeChatMessage(event.message),
      attachments: event.message.attachments.map((attachment) => attachment.id),
    })
  }
  [PrimaryKey.symbol]() {
    return this.key
  }
}

/**
 * A turn a plugin asked for with `Turns.start` or `Turns.queue`, as cluster persists it, so it survives a restart and
 * restores a passivated session (API-72). Its primary key is `start/<random UUID>` (CRON-99).
 */
export class PluginTurn extends Schema.Class<PluginTurn>(
  "chad/Session/PluginTurn",
)({
  key: Schema.String,
  /** The connection whose platform has the thread. */
  connection: Schema.String,
  plugin: Schema.String,
  label: Schema.String,
  prompt: Schema.String,
  mention: Schema.optionalKey(Schema.String),
}) {
  [PrimaryKey.symbol]() {
    return this.key
  }
}

/**
 * How a request ended. The entity posts to chat itself, so `Answered` is the only reply that carries a text.
 * `Steered` and `Dropped` are replies that only an owner's message gets: it joined a running turn, or the turn it was
 * waiting to steer was stopped.
 */
export const Outcome = Schema.Union([
  Schema.TaggedStruct("Answered", { text: Schema.String }),
  Schema.TaggedStruct("Failed", { reason: Failed.Reason }),
  Schema.TaggedStruct("Stopped", {}),
  Schema.TaggedStruct("Steered", {}),
  Schema.TaggedStruct("Dropped", {}),
])
export type Outcome = typeof Outcome.Type

/** A request with its chat message decoded: an owner's message, or a turn a plugin asked for. */
interface Request {
  readonly key: string
  readonly connection: string
  readonly message: ChatMessage.ChatMessage | undefined
  readonly attachments: ReadonlyArray<string>
  readonly plugin:
    | {
        readonly name: string
        readonly label: string
        readonly prompt: string
        readonly mention: string | undefined
      }
    | undefined
}

/** What a `/stop` or a `/new` carries: who sent it, and the connection it arrived on. */
const Command = {
  by: Schema.String,
  connection: Schema.String,
}

/** One session thread. The entity id is the thread string `ChatThread.toString(thread)`. */
export const Session = Entity.make("Session", [
  Rpc.make("message", { payload: Message, success: Outcome }).annotate(
    ClusterSchema.Persisted,
    true,
  ),
  Rpc.make("plugin", { payload: PluginTurn, success: Outcome }).annotate(
    ClusterSchema.Persisted,
    true,
  ),
  // Not persisted: a stop that is lost in a crash has nothing left to stop.
  Rpc.make("stop", {
    payload: Command,
    success: Schema.Struct({ stopped: Schema.Boolean }),
  }),
  // Not persisted either. The reply says that the reset is accepted, and not that it is finished.
  Rpc.make("reset", {
    payload: {
      ...Command,
      /** The `/new` message, which the new session's mark starts at. */
      message: Schema.String,
      at: Schema.Number,
      kind: Schema.Literals(["direct", "channel", "thread"]),
    },
  }),
])

/**
 * Whether the daemon is stopping. A request that would start a turn in the wait of a graceful stop starts none, and is
 * left for the next start (SES-201).
 */
/** Whether safe mode is on now, which adds its line to the system prompt (SELF-38). */
export const Safe = Context.Reference<{ readonly on: () => boolean }>(
  "chad/SessionEntity/Safe",
  { defaultValue: () => ({ on: () => false }) },
)

/**
 * The persona of the applied tree, which an apply, a revert or `chad safe off` replaces before the generation bump it
 * comes with. A session takes it when its Agent is built, so a change reaches it through the rebuild of its next turn
 * (SELF-43, SWAP-128).
 */
export const Persona = Context.Reference<{ readonly text: () => string }>(
  "chad/SessionEntity/Persona",
  { defaultValue: () => ({ text: () => "" }) },
)

export const Stopping = Context.Reference<{ readonly stopping: () => boolean }>(
  "chad/SessionEntity/Stopping",
  { defaultValue: () => ({ stopping: () => false }) },
)

/**
 * What the entity needs of the daemon for a turn a plugin started: whether chad is logged out with no login pending,
 * which ends such a turn before the model (API-83), and the owner ids of a connection, which a mention must be one of
 * (API-76).
 */
export const Support = Context.Reference<{
  readonly loggedOut: Effect.Effect<boolean>
  readonly owners: (connection: string) => ReadonlyArray<string>
  /**
   * The session's own record of a plugin turn's end, by its request's key. It resolves a `Turns.start` that waits in
   * this process, whether or not cluster could save the reply (SES-125, API-100).
   */
  readonly ended: (key: string, outcome: Outcome) => void
  /** The owner's timezone now, which every process a session starts gets as `TZ` (IMG-28, CLI-54). */
  readonly timezone: () => string
}>("chad/SessionEntity/Support", {
  defaultValue: () => ({
    loggedOut: Effect.succeed(false),
    owners: () => [],
    ended: () => {},
    timezone: () => "UTC",
  }),
})

/** The answer of a plugin-started turn that is not posted (API-77). */
const silent = "[SILENT]"

/** The text parts of a message, as `Turn.prompt` holds them. */
const textOf = (message: Prompt.Message) =>
  message.role === "user" || message.role === "assistant"
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : ""

/** Whether two sets of chunk texts are the same. */
const sameChunks = (
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
) => a.size === b.size && [...a].every(([name, text]) => b.get(name) === text)

/** The chunks folded into a system prompt that is rendered, in plugin name order (SWAP-36). */
const folded = (chunks: ReadonlyMap<string, string>) =>
  [...chunks]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, text]) => `\n## ${name}\n\n${text}\n`)
    .join("")

/** A failure reason as a plugin sees it, with times as `DateTime.Utc` (API-112). */
const publicReason = (reason: Failed.Reason): PublicSession.FailedReason =>
  reason._tag === "UsageLimit"
    ? reason.resetsAt === undefined
      ? { _tag: "UsageLimit" }
      : { _tag: "UsageLimit", resetsAt: DateTime.makeUnsafe(reason.resetsAt) }
    : reason

/** An outcome as a plugin sees it. A steer's and a drop's never reach one. */
export const publicOutcome = (outcome: Outcome): PublicSession.Outcome =>
  outcome._tag === "Failed"
    ? { _tag: "Failed", reason: publicReason(outcome.reason) }
    : outcome._tag === "Answered"
      ? outcome
      : { _tag: "Stopped" }

/**
 * The system prompt as chad renders it, which is what a session freezes and what its fingerprint is taken of. The
 * persona follows the core block, and safe mode leaves it out (SELF-42, SELF-45, SWAP-28).
 */
export const system = (
  options: {
    readonly toolInstructions: string
    readonly agentsMd: string
  },
  safe = false,
  persona = "",
) => `You are a world-class software engineer: precise and efficient.
${safe ? `\n${Messages.safePrompt}\n` : PersonaFile.section(persona)}
${options.toolInstructions}

${options.agentsMd}
`

/** A session as it is held in memory: its Agent, its executor and what chad has stored of it. */
interface Live {
  readonly id: string
  /** The scope of the Agent and its executor, which a `/new` closes. */
  readonly scope: Scope.Closeable
  agent: Agent.Agent
  /**
   * Builds a new Agent on the same executor, moves the history and the environment onto it and closes the old one's
   * scope. It runs only at a turn's start, when the Agent has nothing running (SWAP-5, SWAP-12 to SWAP-14).
   */
  readonly rebuild: Effect.Effect<void>
  /** The notices of background tasks that ended after the Agent that started them was discarded (SWAP-17). */
  readonly ended: Effect.Effect<ReadonlyArray<string>>
  readonly directory: string
  /** The ids the session's log lines carry, whose turn is the one running (FAIL-25, FAIL-26). */
  readonly ids: Logger.SessionLogIds
  /** The session as a plugin sees it. */
  readonly session: PublicSession.Session
  /** The turn a tool call of the session reads through `CurrentSession.turn` (API-32, API-105). */
  readonly current: {
    turn: PublicSession.Turn | undefined
    steps: TurnLog.Steps | undefined
  }
  /** The plugin generation the Agent was built on, which a turn's start compares with the plugins' (SWAP-1, SWAP-4). */
  plugins: number
  /** The persona as it was when the Agent was built, which a rebuild takes again (SWAP-128). */
  persona: string
  /** The chunk texts the session last saw, by plugin name (SWAP-30). */
  chunks: ReadonlyMap<string, string>
  /** The system prompt the session last sent, with the fingerprint of what chad rendered for it. */
  frozen: { readonly system: string; readonly fingerprint: string } | undefined
  /** Whether the frozen prompt has changed since it was stored. */
  unsaved: boolean
  /** Where the running turn's steps put their lines, which the executor reads for a script (DIS-24). */
  readonly view: { lines: StatusMessage.Lines }
  /**
   * The session's model layer, built once for a generation of the settings and kept in a scope of its own, so that a
   * new one replaces it only when the model or the login changed (MOD-30).
   */
  model:
    | {
        readonly generation: number
        readonly scope: Scope.Closeable
        readonly context: Context.Context<Model.Provided>
      }
    | undefined
}

/** An owner's message that waits to steer the running turn. */
interface Steer {
  readonly key: string
  readonly text: string
  readonly message: ChatMessage.ChatMessage
  /** The reply, or `next` when the turn ended before a run read the message. */
  readonly done: Deferred.Deferred<Outcome | "next">
  fiber: Fiber.Fiber<void> | undefined
}

interface Turn {
  /** The turn id, which a resumed start takes from the row of the request's first attempt. */
  id: string
  /** The key of the request that asked for the turn. */
  readonly key: string
  readonly at: number
  /** The session the turn runs in, once it is built, or nothing when the turn ended before that. */
  readonly open: Deferred.Deferred<Live | undefined>
  readonly ended: Deferred.Deferred<void>
  /** The steers chad has passed to `steer` and not yet recorded, oldest first. */
  readonly steers: Array<Steer>
  usage: Sessions.Usage
  /** What the request's earlier attempts used, which this attempt's totals are added to. */
  earlier: Sessions.Usage
  fiber: Fiber.Fiber<string, unknown> | undefined
  stopped: boolean
  /** Whether a `/new` ended the session, which drops the waiting steers as a stop does. */
  reset: boolean
  /** Whether the model's part is over, after which no message can join the turn. */
  closing: boolean
  /**
   * The messages of the Agent's history that cannot be a steer of this turn: the ones it held when the turn's `send`
   * began, and every one a batch delivered since. Nothing until the turn has sent.
   */
  known: Set<Prompt.Message> | undefined
  /** Whether the batch of the turn's own prompt has come. */
  prompted: boolean
  /** How many messages the turn's own prompt is: the update message, the owner's message and the restart note. */
  size: number
  /** Whether a restart cut an earlier start of the turn, so that this one sends the restart note. */
  resumed: boolean
  /** The turn's status message, once it is opened. */
  status: StatusMessage.StatusMessage | undefined
  /**
   * The model settings, read once as the turn starts. Its row records them and its model layer is built on them, so a
   * change while the turn runs reaches its session's next turn and leaves this one as it is (MOD-117, MOD-18).
   */
  readonly settings: Model.Settings
  /** What the turn's steps have seen, which a wait on a login resets the silence count of (MOD-103). */
  steps: TurnLog.Steps
  /** The owner's messages that chad recorded as having steered the turn (API-55). */
  readonly steered: Array<ChatMessage.ChatMessage>
  /** The history as the turn's `send` began, which what the turn appended is told from (API-55). */
  initial: ReadonlyArray<Prompt.Message> | undefined
  /** Whether the turn's stream carried a compaction (API-60). */
  compacted: boolean
  /** The turn as a plugin sees it, once its start is counted. */
  public: PublicSession.Turn | undefined
}

/** What the entity holds for the thread's current session. A `/new` puts a fresh one in its place. */
interface State {
  live: Live | undefined
  turn: Turn | undefined
  /** Resolves when the `/new` that made this state has finished. No turn starts before it. */
  readonly ready: Deferred.Deferred<void> | undefined
  /** The plugin hooks a compaction queued, which the next turn waits for (SWAP-38). */
  hooks: Effect.Effect<void> | undefined
}

/** What a turn whose end could not be written gives in place of an outcome. */
const unrecorded = "unrecorded" as const

const lower = {
  Answered: "answered",
  Failed: "failed",
  Stopped: "stopped",
} as const

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const timings = yield* Timings
    return Session.toLayer(
      Effect.gen(function* () {
        const address = yield* Entity.CurrentAddress
        const key = address.entityId
        const thread = Option.getOrThrow(ChatThread.fromString(key))
        const scope = yield* Effect.scope
        const volume = yield* Volume
        const models = yield* Model.Models
        const login = yield* Login.Login
        const notices = yield* Notices.Notices
        const chats = yield* Chats
        const fs = yield* FileSystem.FileSystem
        const plugins = yield* Plugins
        // The one MCP wrapper of the process, which every Agent is handed (MCP-65).
        const mcp = yield* Effect.serviceOption(McpServers.McpServers)
        const support = yield* Support
        const services = yield* Effect.context<
          Sharding.Sharding | Entity.CurrentAddress | SqlClient.SqlClient
        >()
        let state: State = {
          live: undefined,
          turn: undefined,
          ready: undefined,
          hooks: undefined,
        }
        const stopping = yield* Stopping
        const safe = yield* Safe
        const persona = yield* Persona
        // The request of a turn that a restart cut takes the session before any other request of the thread, so
        // that the messages that waited to steer it steer it again (SES-200).
        const unfinished = yield* Sessions.unfinished(key).pipe(Effect.orDie)
        let first =
          unfinished === undefined
            ? undefined
            : { key: unfinished, taken: Deferred.makeUnsafe<void>() }
        const take = (request: string) =>
          Effect.sync(() => {
            if (first?.key !== request) return
            Deferred.doneUnsafe(first.taken, Effect.void)
            first = undefined
          })

        yield* Effect.addFinalizer(() =>
          state.live === undefined
            ? Effect.void
            : Logger.event("session.passivated", "A session left memory", {
                session: state.live.id,
              }),
        )

        /** Posts in the thread, and says whether the post reached it, or found the thread gone. */
        const post = (
          chat: ChatService,
          format: Format,
          markdown: string,
          options?: Post.Options,
        ) => Post.post(chat, format, thread, markdown, options)

        /**
         * The owner's message that the answer, the failed-turn message and the give-up message of a turn reply to: the
         * one that started the turn, also when others steered it (DIS-98, DIS-99). A DM gets plain posts (DIS-53), and
         * so does a turn whose message is in the channel that chad opened the thread from (DIS-118). A kind that cannot
         * be read counts as a server thread's, which keeps the ping.
         */
        const replyTo = (request: Request) => {
          const message = request.message
          return message === undefined ||
            ChatThread.toString(message.thread) !== key
            ? Effect.succeed(undefined)
            : Sessions.kindOf(key).pipe(
                Effect.orElseSucceed(() => undefined),
                Effect.map((kind) =>
                  kind === "direct" ? undefined : message.id,
                ),
              )
        }

        /**
         * The mention a plugin-started turn's posts start with: only in a server thread or channel, and only of an
         * owner, so a plugin can ping no one else (API-76). Discord is the one platform with mentions. It is read when
         * the post is made, so an owner removed while the turn ran is not pinged.
         */
        const mentionOf = (request: Request) =>
          Effect.gen(function* () {
            const id = request.plugin?.mention
            if (id === undefined || thread.platform !== "discord")
              return undefined
            if (!support.owners(request.connection).includes(id))
              return undefined
            const kind = yield* Sessions.kindOf(key).pipe(
              Effect.orElseSucceed(() => undefined),
            )
            return kind === "direct" ? undefined : id
          })

        /** Posts with a mention in front, which notifies only that user. */
        const mentioned = (
          chat: ChatService,
          format: Format,
          mention: string | undefined,
          markdown: string,
          options?: Post.Options,
        ) =>
          mention === undefined
            ? post(chat, format, markdown, options)
            : post(chat, format, `<@${mention}> ${markdown}`, options).pipe(
                DiscordChat.withPostOptions({ notify: { users: [mention] } }),
              )

        /** A plugin-started turn whose thread is gone tells the owner by the notice route (FAIL-173). */
        const threadGone = (request: Request) =>
          request.plugin === undefined
            ? Effect.void
            : notices
                .announce(
                  Messages.threadGone(
                    request.plugin.name,
                    request.plugin.label,
                  ),
                )
                .pipe(Effect.asVoid)

        /**
         * Tells the owner about the files of a message that chad skipped, once for a message, though a message that
         * waited to steer a turn and then starts the next one has its files read twice.
         */
        const told = new Set<string>()
        const tell = Effect.fnUntraced(function* (
          chat: ChatService,
          format: Format,
          request: Request,
          read: Attachments.Read,
        ) {
          if (read.notices.length === 0 || told.has(request.key)) return
          told.add(request.key)
          for (const notice of read.notices) yield* post(chat, format, notice)
        })

        /**
         * The session's Agent, built when a turn needs it. It works in the session's own directory, and it takes the
         * history, the environment and the frozen system prompt that are stored for the session.
         */
        const start = Effect.fnUntraced(function* () {
          // The gateway handler opens the row before it saves a message, and a `/new` swaps it in one transaction.
          const row = yield* Sessions.current(key)
          if (row === undefined) {
            return yield* Effect.die(new Error(`no session row for ${key}`))
          }
          const id = row.id
          // Resolved against the daemon's directory, so that the Agent's cwd and the paths in its prompt are absolute
          // whether CHAD_DATA is or not.
          const directory = resolve(volume.sessions, id)
          yield* Effect.orDie(fs.makeDirectory(directory, { recursive: true }))
          const own = yield* Scope.fork(scope)

          // The background tasks of the session. While one runs the entity is held, so that the idle time does not
          // take the process away from under it.
          const tasks = new Map<string, string>()
          const record = Effect.suspend(() =>
            Sessions.tasks(
              id,
              [...tasks].map(([task, kind]) => ({ id: task, kind })),
            ),
          ).pipe(Effect.ignore)
          yield* Scope.addFinalizer(
            own,
            Effect.suspend(() =>
              tasks.size === 0 ? Effect.void : Entity.keepAlive(false),
            ).pipe(Effect.provideContext(services)),
          )
          // The Agents of the session are numbered as they are built. A task that ends is kept with the number of the Agent
          // that started it, so a later Agent can announce it once that Agent is discarded (SWAP-17, SWAP-132).
          const agents = { current: 0 }
          const starters = new Map<string, number>()
          const endings: Array<{
            readonly agent: number
            readonly handle: TaskHandle
            readonly task: Task
          }> = []
          const track = (task: TaskHandle) =>
            Effect.gen(function* () {
              tasks.set(task.id, task.kind)
              yield* record
              yield* Entity.keepAlive(true)
              yield* task.await.pipe(
                Effect.tap((ended) =>
                  Effect.sync(() => {
                    endings.push({
                      agent: starters.get(task.id) ?? agents.current,
                      handle: task,
                      task: ended,
                    })
                  }),
                ),
                Effect.andThen(
                  Effect.gen(function* () {
                    tasks.delete(task.id)
                    yield* record
                    if (tasks.size === 0) yield* Entity.keepAlive(false)
                  }),
                ),
                Effect.forkIn(own),
              )
            }).pipe(Effect.provideContext(services))

          // Every process the session starts carries the session id, through a spawner of the session's own. A tool
          // call runs on a fiber made from the context of this build, so the session's ids are provided to it.
          const ids: Logger.SessionLogIds = {
            session: id,
            turn: undefined,
            subagents: new Map(),
          }
          const session: PublicSession.Session = {
            id,
            thread,
            kind: row.kind ?? "thread",
            directory,
          }
          const current: {
            turn: PublicSession.Turn | undefined
            steps: TurnLog.Steps | undefined
          } = {
            turn: undefined,
            steps: undefined,
          }
          // Every plugin's tools, whose handlers see this session and the turn that runs (API-30 to API-32). They are
          // taken again for each Agent, so a swap reaches a session at its next turn (SWAP-1, SWAP-6).
          const currentSession = PublicSession.CurrentSession.of({
            session,
            turn: Effect.sync(() => Option.fromUndefinedOr(current.turn)),
          })
          const subagents = () => current.steps?.subagents.size ?? 0
          const view = { lines: StatusMessage.none }
          const built = yield* Layer.buildWithScope(
            AgentExecutor.layerLocal({ directory }).pipe(
              Layer.provide(Spawner.layer(id, volume.home, support.timezone)),
            ),
            own,
          ).pipe(Effect.provideService(Logger.CurrentLogIds, ids))
          const inner = Context.get(built, AgentExecutor.AgentExecutor)
          // A sub-agent's number by the environment clanka starts it in, until its first script ties the number to its
          // task owner (FAIL-241, FAIL-328). An environment rendered from a numbered one keeps the number.
          const starting = new WeakMap<
            AgentExecutor.ExecutionEnvironment,
            number
          >()
          const subagentOf = (options: AgentExecutor.ExecuteOptions) => {
            const owner = options.agentId
            const known =
              owner === undefined ? undefined : ids.subagents.get(owner)
            if (known !== undefined) return known
            const first = starting.get(options.environment)
            if (first !== undefined && owner !== undefined) {
              ids.subagents.set(owner, first)
            }
            return first
          }
          // A sub-agent's fiber is marked with its number where it starts, so that its compactions, which the Agent's
          // output leaves out for a background sub-agent, are logged with it (FAIL-249).
          // `messageAgent` starts a new turn only for a sub-agent that is not running, and clanka runs that turn in the
          // background (`Agent.ts:712-725`).
          const agentTasks = (
            tasks: AgentExecutor.ExecuteAgentTasks,
            parent: ReadonlyArray<TurnLog.Marked>,
          ): AgentExecutor.ExecuteAgentTasks => ({
            ...tasks,
            subagent: (options) =>
              Effect.suspend(() => {
                const subagent = Number(options.id.slice("subagent_".length))
                starting.set(options.environment.environment, subagent)
                return tasks.subagent(options).pipe(
                  TurnLog.mark(parent, {
                    id: subagent,
                    hidden:
                      options.background || parent.at(-1)?.hidden === true,
                  }),
                )
              }),
            messageAgent: (options) =>
              tasks.messageAgent(options).pipe(
                TurnLog.mark(parent, {
                  id: Number(options.id.slice("subagent_".length)),
                  hidden: true,
                }),
              ),
          })
          const render = inner.renderEnvironment
          const executor = AgentExecutor.AgentExecutor.of({
            capabilities: inner.capabilities,
            executeUnsafe: inner.executeUnsafe.bind(inner),
            renderEnvironment:
              render === undefined
                ? undefined
                : (environment, options) =>
                    render(environment, options).pipe(
                      Effect.tap((update) =>
                        Effect.sync(() => {
                          const subagent = starting.get(environment)
                          if (subagent !== undefined) {
                            starting.set(update.environment, subagent)
                          }
                        }),
                      ),
                      Effect.tap(() =>
                        TurnLog.compacted(
                          ids,
                          options?.reset === true,
                          view.lines,
                        ),
                      ),
                    ),
            // A script is logged here, where every agent's script runs, a background sub-agent's included (FAIL-13,
            // FAIL-14, FAIL-192). clanka reports a script's failure through the logger, with the script's own output
            // as the console, and chad's logger prints such a line into the script's output (FAIL-23).
            execute: (options) => {
              const subagent = subagentOf(options)
              return Stream.unwrap(
                Effect.gen(function* () {
                  // `execute` runs on the fiber of the agent whose script it is.
                  const parent = yield* TurnLog.chain
                  const ran = inner.execute({
                    ...options,
                    agentTasks: agentTasks(options.agentTasks, parent),
                    onTask: (task) =>
                      Effect.andThen(
                        track(task),
                        options.onTask?.(task) ?? Effect.void,
                      ),
                  })
                  yield* TurnLog.scriptStarted(
                    ids,
                    subagent,
                    options.script,
                    view.lines,
                  )
                  const at = Date.now()
                  let text = ""
                  // The end is logged however the script ends, a stop included, with what it printed so far (FAIL-192).
                  return ran.pipe(
                    Stream.tap((chunk) =>
                      Effect.sync(() => {
                        text += chunk
                      }),
                    ),
                    Stream.ensuring(
                      Effect.suspend(() =>
                        TurnLog.scriptEnded(
                          ids,
                          subagent,
                          text,
                          Date.now() - at,
                        ),
                      ),
                    ),
                  )
                }),
              ).pipe(Stream.provideService(Logger.CurrentSubagent, subagent))
            },
          })
          /**
           * One Agent in a scope of its own, on the session's one executor. Its root agent's scripts run under the session
           * id as their task owner, so a later Agent lists and reads the tasks an earlier one started (SWAP-15, SWAP-16).
           */
          const build = Effect.fnUntraced(function* () {
            const number = ++agents.current
            const agentScope = yield* Scope.fork(own)
            let root: string | undefined
            const owned = AgentExecutor.AgentExecutor.of({
              ...executor,
              execute: (options) => {
                root ??= options.agentId
                return executor.execute({
                  ...options,
                  ...(options.agentId === root ? { agentId: id } : {}),
                  onTask: (task) =>
                    Effect.andThen(
                      Effect.sync(() => starters.set(task.id, number)),
                      options.onTask?.(task) ?? Effect.void,
                    ),
                })
              },
            })
            const generation = plugins.generation()
            const tools = plugins.tools(
              currentSession,
              subagents,
              () => tasks.size,
            )
            const agent = yield* (
              tools === undefined
                ? Agent.make
                : (Agent.makeWith({ loopTools: tools.toolkit }).pipe(
                    Effect.provide(tools.context),
                  ) as Effect.Effect<
                    Agent.Agent,
                    never,
                    AgentExecutor.AgentExecutor | Scope.Scope
                  >)
            ).pipe(
              Effect.provideService(AgentExecutor.AgentExecutor, owned),
              Effect.provideService(Scope.Scope, agentScope),
              Effect.provideService(Logger.CurrentLogIds, ids),
              (effect) =>
                Option.isSome(mcp)
                  ? Effect.provideService(
                      effect,
                      McpServers.McpServers,
                      mcp.value,
                    )
                  : effect,
            )
            return {
              agent,
              scope: agentScope,
              generation,
              persona: persona.text(),
            }
          })
          let {
            agent,
            scope: agentScope,
            generation,
            persona: firstPersona,
          } = yield* build()
          const messages = yield* Sessions.history(id)
          if (messages.length > 0) {
            MutableRef.set(agent.history, Prompt.fromMessages(messages))
          }
          if (row.environment !== null) {
            MutableRef.set(
              agent.environment,
              Sessions.environment(row.environment),
            )
          }
          if (messages.length > 0) {
            yield* Logger.event("session.restored", "A session was restored", {
              session: id,
              messages: messages.length,
            })
          }
          const live: Live = {
            id,
            scope: own,
            agent,
            rebuild: Effect.gen(function* () {
              const next = yield* build()
              MutableRef.set(next.agent.history, live.agent.history.current)
              MutableRef.set(
                next.agent.environment,
                live.agent.environment.current,
              )
              yield* Scope.close(agentScope, Exit.void)
              agent = live.agent = next.agent
              agentScope = next.scope
              live.plugins = next.generation
              live.persona = next.persona
            }),
            // Each task is announced once: only one an earlier Agent started, and only if nothing reported it yet
            // (SWAP-134 to SWAP-137).
            ended: Effect.gen(function* () {
              const due = endings.filter(
                (entry) => entry.agent < agents.current,
              )
              for (const entry of due) endings.splice(endings.indexOf(entry), 1)
              const notices: Array<string> = []
              for (const { handle, task } of due) {
                if (yield* handle.claim) notices.push(Messages.taskEnded(task))
              }
              return notices
            }),
            directory,
            ids,
            session,
            current,
            chunks: new Map(
              Object.entries(
                row.chunks === null
                  ? {}
                  : (JSON.parse(row.chunks) as Record<string, string>),
              ),
            ),
            frozen:
              row.system === null || row.fingerprint === null
                ? undefined
                : { system: row.system, fingerprint: row.fingerprint },
            unsaved: false,
            view,
            model: undefined,
            plugins: generation,
            persona: firstPersona,
          }
          return live
        })

        /**
         * The `system` function of a `send`. A session keeps the prompt it sent, and sends that text again for as long
         * as the fingerprint of what chad would render now is the one it was frozen with.
         */
        const frozen =
          (live: Live, chunks: ReadonlyMap<string, string>) =>
          (options: {
            readonly toolInstructions: string
            readonly agentsMd: string
          }) => {
            // Safe mode is one line of the prompt, which is part of the fingerprint, so turning it on or off renders
            // the prompt again (SELF-38, SELF-39).
            const rendered = system(options, safe.on(), live.persona)
            // The fingerprint leaves the chunks out, so a chunk change keeps the prompt frozen (SWAP-129).
            const fingerprint = createHash("sha256")
              .update(rendered)
              .digest("hex")
            if (live.frozen?.fingerprint !== fingerprint) {
              live.frozen = { system: rendered + folded(chunks), fingerprint }
              live.unsaved = true
            }
            return live.frozen.system
          }

        const saveFrozen = (live: Live) =>
          Effect.suspend(() => {
            if (!live.unsaved || live.frozen === undefined) return Effect.void
            live.unsaved = false
            return Sessions.freeze(
              live.id,
              live.frozen.system,
              live.frozen.fingerprint,
            )
          })

        /** Answers the steers a stored batch carried, each with its log line. Their rows are written by then. */
        const steered = Effect.fnUntraced(function* (
          live: Live,
          turn: Turn,
          steers: ReadonlyArray<Steer>,
        ) {
          for (const steer of steers) {
            turn.steers.splice(turn.steers.indexOf(steer), 1)
            turn.steered.push(steer.message)
            // The status message's line and the log line of a steer the agent read come from here (DIS-30, FAIL-11).
            yield* (turn.status ?? StatusMessage.none).add(
              Messages.statusRead(steer.text),
            )
            yield* Logger.event("turn.steered", "A message steered the turn", {
              session: live.id,
              turn: turn.id,
              request: steer.key,
            })
            Deferred.doneUnsafe(
              steer.done,
              Effect.succeed({ _tag: "Steered" } as const),
            )
          }
        })

        const rows = (turn: Turn, steers: ReadonlyArray<Steer>) =>
          steers.map((steer) => ({ key: steer.key, turn: turn.id }))

        /**
         * The steers a batch carries. The batch is clanka's own when every message in it is a user message with
         * string content and the contents are, in order, those of the oldest steers that are not recorded yet.
         */
        const carried = (
          turn: Turn,
          messages: ReadonlyArray<Prompt.Message>,
        ): ReadonlyArray<Steer> =>
          messages.length > 0 &&
          messages.length <= turn.steers.length &&
          messages.every(
            (message, index) =>
              Sessions.textOf(message) === turn.steers[index]?.text,
          )
            ? turn.steers.slice(0, messages.length)
            : []

        /** The model's part of a turn: the prompt goes in, the history is stored as it grows, and the answer comes out. */
        const converse = Effect.fnUntraced(function* (
          live: Live,
          turn: Turn,
          request: Request,
          chat: ChatService,
          format: Format,
        ) {
          // A resumed start sends the restart note in place of the owner's message when the stored history holds that
          // message. When a kill came before it was stored, the message goes first and the note after it (SES-161).
          const held = turn.resumed && (yield* Sessions.holds(turn.key))
          const message = request.message
          const read =
            held || message === undefined
              ? undefined
              : yield* Attachments.read({
                  chat,
                  format,
                  message,
                  attachments: request.attachments,
                  directory: live.directory,
                  asImages: true,
                })
          if (read !== undefined) yield* tell(chat, format, request, read)
          // The turn's own message: the owner's with the lines for its files, or the plugin's prompt, to which chad's
          // core adds no line (SELF-40, API-82).
          const own = held
            ? undefined
            : read !== undefined
              ? Attachments.prompt(read, Sessions.promptOf(turn.key))
              : request.plugin !== undefined
                ? Prompt.userMessage({
                    content: [Prompt.textPart({ text: request.plugin.prompt })],
                    options: Sessions.promptOf(turn.key),
                  })
                : undefined
          const note = Prompt.userMessage({
            content: [Prompt.textPart({ text: Messages.restartNote() })],
          })
          const main =
            own === undefined ? [note] : [own, ...(turn.resumed ? [note] : [])]
          // `Turn.prompt` is the text that starts the turn, with the lines for files and the restart note (API-50).
          const publicTurn: PublicSession.Turn = {
            ...turn.public!,
            prompt: main.map(textOf).join("\n\n"),
          }
          turn.public = publicTurn
          live.current.turn = publicTurn
          live.current.steps = turn.steps

          // Every chunk is rendered and compared with what the session last saw. A render that failed keeps that text,
          // and a plugin with no chunk now has its section removed (SWAP-30, SWAP-33, SWAP-35).
          const rendered = yield* plugins.chunks(live.session)
          const next = new Map<string, string>()
          for (const [name, text] of rendered) {
            const kept = text === undefined ? live.chunks.get(name) : text
            if (kept !== undefined && kept !== "") next.set(name, kept)
          }
          // A session with no frozen prompt renders one now with the chunks folded in, and needs no update for them.
          const fresh = live.frozen === undefined
          const changes = fresh
            ? []
            : [
                ...[...next]
                  .filter(([name, text]) => live.chunks.get(name) !== text)
                  .map(([plugin, text]) => ({ plugin, text })),
                ...[...live.chunks.keys()]
                  .filter((name) => !next.has(name))
                  .map((plugin) => ({ plugin, text: undefined })),
              ].sort((a, b) => (a.plugin < b.plugin ? -1 : 1))
          // A prompt rendered again keeps the chunks the session saw before the turn, so the update says the rest.
          const fold = fresh ? next : live.chunks

          // What chad posted in the thread since the last answer the owner read and the chunks that changed go ahead
          // of the prompt, in one update message that the system prompt does not change for (FAIL-125, FAIL-127,
          // FAIL-131, SWAP-31, SWAP-117).
          const pending = yield* Sessions.updates(live.id)
          const outlived = yield* live.ended
          const sections = [
            ...outlived,
            ...(changes.length === 0 ? [] : [Messages.chunksChanged(changes)]),
            ...[Messages.updateBody(pending.lines)].filter(
              (body): body is string => body !== undefined,
            ),
          ]
          const update =
            sections.length === 0
              ? []
              : [
                  Prompt.userMessage({
                    content: [
                      Prompt.textPart({
                        text: Messages.environmentUpdate(sections),
                      }),
                    ],
                    ...(pending.last === undefined
                      ? {}
                      : { options: Sessions.updateOf(pending.last) }),
                  }),
                ]
          // The `beforeTurn` texts follow the update, each its own message, in plugin name order (SES-60, API-49).
          const contexts = yield* plugins.beforeTurn(publicTurn)
          const messages = [
            ...update,
            ...contexts.map(({ plugin, text }) =>
              Prompt.userMessage({
                content: [
                  Prompt.textPart({
                    text: Messages.pluginContext(plugin, text),
                  }),
                ],
              }),
            ),
            ...main,
          ]
          turn.size = messages.length
          turn.initial = live.agent.history.current.content
          const known = new Set(live.agent.history.current.content)
          turn.known = known
          const steps = TurnLog.steps()
          turn.steps = steps
          // chad's end of the turn at a model call of an agent whose parts the output leaves out (FAIL-84, FAIL-87).
          const ended = Deferred.makeUnsafe<never, Failed.Ended>()
          const owner: TurnLog.Owner = {
            steps,
            loginPending: () => login.pendingFor(live.id),
            // Every model call that succeeds clears the conditions a model call or the check at start began, whichever
            // turn makes it and however many of its calls came before (FAIL-94, FAIL-235). A key whose row does not
            // hold costs no read.
            succeeded: Effect.all(
              [
                notices.clear(Notices.usageLimitKey),
                notices.clear(Model.checkKey),
                notices.clear(Notices.loggedOutKey),
              ],
              { discard: true },
            ),
            end: (reason) =>
              Deferred.doneUnsafe(
                ended,
                Effect.fail(new Failed.Ended({ reason })),
              ),
          }
          // The agents of the turn run with the context `send` starts in, so each of them has the owner.
          const output = yield* live.agent
            .send({
              prompt:
                messages.length === 1 && messages[0] === note
                  ? Messages.restartNote()
                  : Prompt.fromMessages(messages),
              system: frozen(live, fold),
            })
            .pipe(Effect.provideService(TurnLog.CurrentOwner, owner))
          yield* saveFrozen(live)
          if (!sameChunks(live.chunks, next)) {
            live.chunks = next
            yield* Sessions.chunks(live.id, Object.fromEntries(next))
          }
          const ids = { session: live.id, turn: turn.id }
          return yield* output.pipe(
            Stream.runForEach((part) =>
              Effect.gen(function* () {
                yield* TurnLog.step(
                  steps,
                  ids,
                  part,
                  turn.status ?? StatusMessage.none,
                  () => login.pendingFor(live.id),
                )
                if (part._tag === "HistoryAppended") {
                  yield* saveFrozen(live)
                  for (const message of part.messages) known.add(message)
                  // The first batch is the turn's own prompt, which is no steer whatever it says.
                  const steers = turn.prompted
                    ? carried(turn, part.messages)
                    : []
                  turn.prompted = true
                  yield* Sessions.append(
                    live.id,
                    part.messages,
                    live.agent.environment.current,
                    rows(turn, steers),
                  )
                  yield* steered(live, turn, steers)
                } else if (part._tag === "HistoryReplaced") {
                  turn.compacted = true
                  for (const message of part.messages) known.add(message)
                  yield* Sessions.replace(
                    live.id,
                    part.messages,
                    live.agent.environment.current,
                  )
                }
                if (part._tag === "Usage") {
                  // A part holds the running totals of this `send`, and the context size of the latest call.
                  turn.usage = {
                    inputTokens: turn.earlier.inputTokens + part.inputTokens,
                    outputTokens: turn.earlier.outputTokens + part.outputTokens,
                    cacheRead: turn.earlier.cacheRead + part.cacheRead,
                    cacheWrite: turn.earlier.cacheWrite + part.cacheWrite,
                    contextTokens: part.contextTokens,
                  }
                  yield* Sessions.usage(turn.key, turn.usage)
                }
              }),
            ),
            Effect.raceFirst(Deferred.await(ended)),
            // A sub-agent whose end the output did not carry, because the turn stopped or failed while it ran, gets its
            // end line here (FAIL-193).
            Effect.ensuring(TurnLog.unended(steps, ids)),
            Effect.as(""),
            Effect.catchTag("AgentFinished", (finished) =>
              Effect.succeed(finished.summary),
            ),
          )
        }, Effect.scoped)

        /** The turn that asks the login for a token now, which the session's reference reads. */
        let asking:
          | {
              readonly turn: Turn
              readonly chat: ChatService
              readonly format: Format
              waited: boolean
              /** Whether an owner's message started the turn (MOD-42). */
              readonly owner: boolean
            }
          | undefined
        let reference:
          { readonly live: Live; readonly ref: Login.SessionRef } | undefined

        /**
         * The session as the login sees it. It stays the same for the session's life, because the model layer keeps the
         * one it was built with, and it reads the turn that runs now (MOD-34, MOD-35).
         */
        const sessionRef = (live: Live, format: Format): Login.SessionRef => {
          if (reference?.live === live) return reference.ref
          const say = (markdown: (format: Format) => string) =>
            Effect.suspend(() =>
              asking === undefined
                ? Effect.void
                : post(asking.chat, asking.format, markdown(asking.format)),
            ).pipe(Effect.asVoid)
          const ref: Login.SessionRef = {
            id: live.id,
            get ownerPresent() {
              return asking?.owner ?? true
            },
            link: format.link(thread),
            post: (markdown) => say(() => markdown),
            notice: (line) => say((format) => format.subtext(line)),
            // A turn's wait gets one status line and one log line, however often clanka retries its call (MOD-51).
            waiting: Effect.suspend(() => {
              const now = asking
              if (now !== undefined) TurnLog.loginWaited(now.turn.steps)
              if (now === undefined || now.waited) return Effect.void
              now.waited = true
              return Effect.andThen(
                (now.turn.status ?? StatusMessage.none).add(
                  Messages.statusLoginWait,
                ),
                Logger.event("turn.login-wait", "The turn waits for a login", {
                  session: live.id,
                  turn: now.turn.id,
                }),
              )
            }),
          }
          reference = { live, ref }
          return ref
        }

        /**
         * The model's part on the session's model layer. The token check comes first, then the layer is built when the
         * session has none for the settings in force (SES-56, MOD-30). The session is set around both, so a login either
         * asks for posts its code in this thread (MOD-33, MOD-34).
         */
        const ask = (
          live: Live,
          turn: Turn,
          request: Request,
          chat: ChatService,
          format: Format,
        ) =>
          Effect.suspend(() => {
            asking = {
              turn,
              chat,
              format,
              waited: false,
              owner: request.plugin === undefined,
            }
            return modelPart(live, turn, request, chat, format)
          }).pipe(
            Effect.provideService(
              Login.CurrentSession,
              sessionRef(live, format),
            ),
            // A turn with no owner present never starts a login. It joins one that is pending, and otherwise takes
            // only a token that is good or refreshes (API-83, MOD-94).
            Effect.provideService(
              Login.Unattended,
              request.plugin !== undefined && !login.pending(),
            ),
          )

        const modelPart = Effect.fnUntraced(function* (
          live: Live,
          turn: Turn,
          request: Request,
          chat: ChatService,
          format: Format,
        ) {
          const prepared = yield* models.prepare(live.id, turn.settings)
          // A session behind the plugins' generation rebuilds its Agent at the turn's start, with the tools the
          // plugins have now (SWAP-1, SWAP-4, SWAP-6).
          if (
            live.model !== undefined &&
            live.model.generation === prepared.generation &&
            live.plugins !== plugins.generation()
          ) {
            yield* live.rebuild
          }
          if (live.model?.generation !== prepared.generation) {
            // A session behind the generation rebuilds its Agent here, at a turn's start, through the same bump a
            // model change makes (SWAP-4, SWAP-8, MOD-18).
            if (live.model !== undefined) {
              yield* Scope.close(live.model.scope, Exit.void)
              yield* live.rebuild
            }
            const scope = yield* Scope.fork(live.scope)
            live.model = {
              generation: prepared.generation,
              scope,
              context: yield* Layer.buildWithScope(prepared.layer, scope),
            }
          }
          return yield* converse(live, turn, request, chat, format).pipe(
            Effect.provide(live.model.context),
          )
        })

        /**
         * Makes the stored history equal to the Agent's, over the session's whole history as the database holds it,
         * and gives the number of messages it wrote. A steering message that the Agent holds and no batch delivered is recorded here.
         */
        const reconcile = Effect.fnUntraced(function* (live: Live, turn: Turn) {
          const messages = live.agent.history.current.content.filter(
            (message) => message.role !== "system",
          )
          const encoded = messages.map(Sessions.encode)
          const stored = yield* Sessions.stored(live.id)
          const prefix =
            stored.length <= encoded.length &&
            stored.every((row, index) => row === encoded[index])
          const missing = prefix ? messages.slice(stored.length) : messages
          // A steer of this turn can only be a message the Agent took during it that no batch delivered. A row of an
          // earlier turn that is written again here is none, whatever its text.
          const taken = turn.known
          const unread =
            taken === undefined
              ? []
              : messages.filter((message) => !taken.has(message))
          // Before the prompt's own batch, the first such messages are the prompt.
          const candidates = turn.prompted ? unread : unread.slice(turn.size)
          const steers = Sessions.matched(
            turn.steers.map((steer) => steer.text),
            candidates.map(Sessions.textOf),
          ).map((index) => turn.steers[index]!)
          // A replace that no `HistoryReplaced` announced is a compaction of this turn all the same (SES-135).
          if (!prefix) turn.compacted = true
          const write = prefix ? Sessions.append : Sessions.replace
          yield* write(
            live.id,
            missing,
            live.agent.environment.current,
            rows(turn, steers),
          )
          yield* steered(live, turn, steers)
          if (missing.length > 0) {
            yield* Logger.event(
              "history.reconciled",
              "The stored history was behind the Agent's",
              { session: live.id, turn: turn.id, messages: missing.length },
            )
          }
          return missing.length
        })

        /** Ends a turn for the messages around it: the ones that waited to steer it, and the ones that wait for it. */
        const close = (own: State, turn: Turn) =>
          Effect.gen(function* () {
            turn.closing = true
            Deferred.doneUnsafe(turn.open, Effect.succeed(undefined))
            const waiting = turn.steers.splice(0)
            // An interrupted `steer` takes its message back, so the next `send` does not read it as well.
            for (const steer of waiting) {
              if (steer.fiber !== undefined) yield* Fiber.interrupt(steer.fiber)
            }
            if (own.turn === turn) own.turn = undefined
            if (own.live?.ids.turn === turn.id) own.live.ids.turn = undefined
            if (own.live?.current.turn?.id === turn.id) {
              own.live.current.turn = undefined
              own.live.current.steps = undefined
            }
            if (own.live !== undefined && own.live.view.lines === turn.status) {
              own.live.view.lines = StatusMessage.none
            }
            const reply: Outcome | "next" =
              turn.stopped || turn.reset ? { _tag: "Dropped" } : "next"
            for (const steer of waiting) {
              Deferred.doneUnsafe(steer.done, Effect.succeed(reply))
            }
            Deferred.doneUnsafe(turn.ended, Effect.void)
          })

        /** Whether a reason's turn posts the failed-turn message. The others post a message of their own or nothing. */
        const posted = (
          reason: Failed.Reason,
          request: Request,
        ): reason is Messages.Posted =>
          reason._tag === "ModelError" ||
          reason._tag === "Internal" ||
          // A plugin-started turn posts nothing for these, and a notice goes instead (API-120).
          (request.plugin === undefined &&
            (reason._tag === "LoginFailed" || reason._tag === "UsageLimit"))

        /** What a failed turn's row records of its reason: the tag and the whole reason (STO-76). */
        const recorded = (reason: Failed.Reason) => ({
          tag: reason._tag,
          detail: Failed.detail(reason),
        })

        /**
         * Ends a turn that a defect outside the model's part cut: its row, the failed-turn message and its log line. A
         * turn whose end cannot be written either, or that has no row to write it on, is `unrecorded`: its request
         * gets no reply, so that the next start delivers it again (FAIL-135). It resumes as a turn a crash cut, or,
         * when its row was never written, runs as a fresh delivery.
         */
        const failed = (turn: Turn, own: State, request: Request) =>
          Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
            const connection = request.connection
            const at = Date.now()
            const reason = Failed.classify(cause)
            // A full volume is no special mode: the turn fails as `Internal`, and the log says why (FAIL-135, FAIL-281).
            if (Disk.isFull(cause)) {
              yield* Logger.event(
                "disk.full",
                "A write failed because the data volume is full",
                { connection },
                cause,
              )
            }
            const session = own.live?.id
            const written = yield* Sessions.ended({
              key: turn.key,
              outcome: "failed",
              failure: recorded(reason),
              at,
              tell:
                session === undefined ? undefined : { session, turn: turn.id },
            }).pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logError(
                  "A turn's end could not be recorded",
                  cause,
                ).pipe(Effect.as(false)),
              ),
            )
            // The status message goes however the turn ends (DIS-35), and a turn whose end is not written finds it gone
            // when it is delivered again.
            if (turn.status !== undefined) yield* turn.status.remove
            // In a server thread it replies to the owner's message, which pings them (FAIL-66).
            if (posted(reason, request)) {
              yield* Effect.all([
                chats.get(connection),
                chats.format(connection),
                replyTo(request),
                mentionOf(request),
              ]).pipe(
                Effect.flatMap(([chat, format, reply, mention]) =>
                  mentioned(
                    chat,
                    format,
                    mention,
                    Messages.failedTurn(format, at - turn.at, reason, turn.id),
                    { replyTo: reply },
                  ),
                ),
                Effect.catchCause((cause) =>
                  Effect.logError("A message could not be posted", cause),
                ),
              )
            }
            yield* TurnLog.failed(
              {
                session,
                turn: turn.id,
                duration: at - turn.at,
                usage: turn.usage,
                reconciled: 0,
              },
              reason._tag,
              cause,
            )
            if (written) return { _tag: "Failed", reason } as const
            // The request stays unanswered for the next start, and a `Turns.start` waiting here has its outcome now.
            support.ended(turn.key, { _tag: "Failed", reason })
            return unrecorded
          })

        /** One turn, from the request that takes the session to the reply. */
        const run = Effect.fnUntraced(function* (
          own: State,
          turn: Turn,
          request: Request,
        ) {
          const chat = yield* chats.get(request.connection)
          const format = yield* chats.format(request.connection)
          const reply = yield* replyTo(request)
          if (own.ready !== undefined) yield* Deferred.await(own.ready)
          // The plugins are loaded before a turn starts, and the hooks a compaction queued have run (SWAP-38).
          yield* plugins.ready
          if (own.hooks !== undefined) {
            const hooks = own.hooks
            own.hooks = undefined
            yield* hooks
          }
          // The start is counted first, since the row holds the status message an earlier start posted.
          const counted = yield* Effect.exit(
            Effect.gen(function* () {
              // The gateway handler opens the row before it saves a message, and a `/new` swaps it in one transaction.
              const row =
                own.live === undefined
                  ? yield* Sessions.current(key)
                  : undefined
              const session = own.live?.id ?? row?.id
              if (session === undefined) {
                return yield* Effect.die(new Error(`no session row for ${key}`))
              }
              const started = yield* Sessions.started({
                key: turn.key,
                turn: turn.id,
                session,
                model: Model.text(turn.settings),
                at: turn.at,
                plugin:
                  request.plugin === undefined
                    ? undefined
                    : {
                        name: request.plugin.name,
                        label: request.plugin.label,
                      },
              })
              turn.id = started.turn
              turn.usage = turn.earlier = started.earlier
              turn.resumed = started.starts > 1
              // A resumed turn keeps the first attempt's id and origin (API-51).
              turn.public = {
                id: turn.id,
                session: own.live?.session ?? {
                  id: session,
                  thread,
                  kind: row?.kind ?? "thread",
                  directory: resolve(volume.sessions, session),
                },
                origin:
                  request.plugin === undefined
                    ? { _tag: "Message", message: request.message! }
                    : {
                        _tag: "Plugin",
                        plugin: request.plugin.name,
                        label: request.plugin.label,
                      },
                prompt: request.plugin?.prompt ?? request.message?.text ?? "",
                startedAt: DateTime.makeUnsafe(started.at),
                resumed: turn.resumed,
              }
              return { session, started }
            }),
          )
          if (Exit.isFailure(counted)) {
            return yield* failed(turn, own, request)(counted.cause)
          }
          const { session, started } = counted.value
          const ids = { session, turn: turn.id }
          // After two starts that a kill ended, the model does not run again (SES-106). The status message the turn
          // left behind goes, and the give-up message is posted in place of the failed-turn message (DIS-62, FAIL-63).
          if (Sessions.kills(started) >= 2) {
            const at = Date.now()
            const reason: Failed.Reason = { _tag: "GaveUp" }
            yield* Sessions.ended({
              key: turn.key,
              outcome: "failed",
              failure: recorded(reason),
              at,
              tell: ids,
            })
            yield* chats.ready(request.connection)
            if (started.status !== undefined) {
              yield* StatusMessage.discard(chat, thread, started.status)
            }
            yield* mentioned(
              chat,
              format,
              yield* mentionOf(request),
              Messages.gaveUp(format, turn.id),
              {
                replyTo: reply,
              },
            )
            yield* TurnLog.failed(
              {
                ...ids,
                duration: at - turn.at,
                usage: turn.usage,
                reconciled: 0,
              },
              "GaveUp",
            )
            return { _tag: "Failed", reason } as const
          }
          // The first start writes `turn.started`, and each later one `turn.resumed` (FAIL-326). Only the delivery that
          // gives up, above, writes neither. They come before anything that can fail, so that a turn that ends early has
          // its start in the log too (FAIL-12). A later start's status line waits for the status message.
          const early = StatusMessage.pending()
          const origin = request.plugin === undefined ? "message" : "plugin"
          if (turn.resumed) {
            yield* TurnLog.resumed(ids, origin, started.starts, early)
          } else {
            yield* TurnLog.started(ids, origin)
          }
          /** Ends the turn before the model runs and before anything is posted in its thread. */
          const endsEarly = Effect.fnUntraced(function* (
            reason: Failed.Reason,
          ) {
            const at = Date.now()
            yield* Sessions.ended({
              key: turn.key,
              outcome: "failed",
              failure: recorded(reason),
              at,
            })
            yield* TurnLog.failed(
              {
                ...ids,
                duration: at - turn.at,
                usage: turn.usage,
                reconciled: 0,
              },
              reason._tag,
            )
            return { _tag: "Failed", reason } as const
          })
          // A turn a plugin started on a chad that is logged out, with no login pending, ends before its status message
          // is posted, so a skipped run makes no sound in the thread (API-83, DIS-91, FAIL-175).
          if (request.plugin !== undefined && (yield* support.loggedOut)) {
            yield* notices.raise({
              key: Notices.loggedOutKey,
              text: Messages.loggedOutNotice,
            })
            return yield* endsEarly({ _tag: "LoggedOut" })
          }
          // The status message comes before the Agent is built and before anything the turn sends (DIS-19). A
          // delivery at boot comes before the platform may have answered.
          yield* chats.ready(request.connection)
          const status = yield* StatusMessage.open({
            chat,
            thread,
            format,
            // A resumed turn's header keeps the time its first attempt started.
            at: started.at,
            stored: started.status,
            interval: timings.statusEditInterval,
            scope,
          })
          // A thread that is gone ends the turn before the model runs, and nothing is posted (DIS-94, FAIL-207).
          if (status === "gone") {
            yield* threadGone(request)
            return yield* endsEarly({ _tag: "ThreadGone" })
          }
          turn.status = status
          // The id goes into the row as soon as the post returns, before anything else of the turn (DIS-90, STO-75).
          if (status.id !== undefined && status.id !== started.status) {
            yield* Sessions.status(turn.key, status.id)
          }
          yield* early.into(status)
          const built = yield* Effect.exit(
            Effect.gen(function* () {
              own.live ??= yield* start()
              return own.live
            }),
          )
          if (Exit.isFailure(built)) {
            return yield* failed(turn, own, request)(built.cause)
          }
          const live = built.value
          live.view.lines = status
          // A line the session logs from here until the turn closes carries the turn's id (FAIL-26).
          live.ids.turn = turn.id
          Deferred.doneUnsafe(turn.open, Effect.succeed(live))

          // The model's part runs in a fiber of its own, which is what a stop interrupts. A turn that was stopped
          // while it was starting never reaches the model.
          let exit: Exit.Exit<string, unknown> = Exit.succeed("")
          if (!turn.stopped) {
            const fiber = yield* Effect.forkChild(
              ask(live, turn, request, chat, format),
            )
            turn.fiber = fiber
            if (turn.stopped) yield* Fiber.interrupt(fiber)
            // Only a shutdown interrupts the turn itself, at the end of the wait for requests in flight. The cut is
            // recorded with the reconcile, and the request is left unanswered for the next start (SES-112, FAIL-327).
            exit = yield* Fiber.await(fiber).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  turn.closing = true
                  yield* Fiber.interrupt(fiber)
                  yield* reconcile(live, turn)
                  yield* Sessions.cut(turn.key)
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError(
                      "A graceful cut could not be recorded",
                      cause,
                    ),
                  ),
                ),
              ),
            )
          }

          // Neither a stop nor a shutdown interrupts the reconcile, and the turn's end is recorded after it.
          const end = yield* Effect.gen(function* () {
            turn.closing = true
            const reconciled = yield* reconcile(live, turn)
            const outcome: Outcome = turn.stopped
              ? { _tag: "Stopped" }
              : Exit.isSuccess(exit)
                ? { _tag: "Answered", text: exit.value }
                : { _tag: "Failed", reason: Failed.classify(exit.cause) }
            const at = Date.now()
            // A stop and a failure are posted in place of an answer, so the next turn tells the model of them
            // (FAIL-125), and their line is written with the end.
            yield* Sessions.ended({
              key: turn.key,
              outcome: lower[outcome._tag],
              failure:
                outcome._tag === "Failed"
                  ? recorded(outcome.reason)
                  : undefined,
              at,
              tell: outcome._tag === "Answered" ? undefined : ids,
            })
            return { outcome, reconciled, at }
          }).pipe(Effect.uninterruptible, Effect.exit)
          if (Exit.isFailure(end))
            return yield* failed(turn, own, request)(end.cause)

          const { outcome, reconciled, at } = end.value
          // The status message goes however the turn ends, before what it ends with is posted (DIS-35, OV-28).
          yield* status.remove
          const fields: TurnLog.End = {
            ...ids,
            duration: at - turn.at,
            usage: turn.usage,
            reconciled,
          }
          if (outcome._tag === "Failed") {
            const reason = outcome.reason
            // An owner's turn tells the owner in the thread, so the condition's row records the limit and no notice goes
            // (FAIL-94, FAIL-319). A plugin's turn posts nothing for it, so the notice goes (FAIL-174, FAIL-210).
            if (reason._tag === "UsageLimit") {
              const notice = {
                key: Notices.usageLimitKey,
                text: Messages.usageLimitNotice(reason.resetsAt),
              }
              yield* request.plugin === undefined
                ? notices.record(notice)
                : notices.raise(notice)
            }
            // A plugin's turn that a failed login ended begins the logged-out condition (FAIL-210, MOD-106).
            if (reason._tag === "LoginFailed" && request.plugin !== undefined) {
              yield* notices.raise({
                key: Notices.loggedOutKey,
                text: Messages.loggedOutNotice,
              })
            }
            if (posted(outcome.reason, request)) {
              yield* mentioned(
                chat,
                format,
                yield* mentionOf(request),
                Messages.failedTurn(
                  format,
                  at - turn.at,
                  outcome.reason,
                  turn.id,
                ),
                { replyTo: reply },
              )
            }
            yield* TurnLog.failed(
              fields,
              reason._tag,
              Exit.isFailure(exit) ? exit.cause : undefined,
              // The reset time of a usage limit is on the turn's one line (FAIL-242, MOD-114).
              reason._tag === "UsageLimit" && reason.resetsAt !== undefined
                ? { resets_at: new Date(reason.resetsAt).toISOString() }
                : {},
            )
            return outcome
          }
          // The answer goes out through the connection the message arrived on, as a reply to the owner's message in a
          // server thread (DIS-55). An answer that could not be posted, also the second time (DIS-54), leaves the turn
          // `Answered`, because the history holds it (FAIL-51), and the model is told that the owner has not read it
          // (FAIL-129).
          // A plugin-started turn's answer that is exactly `[SILENT]` is not posted (API-77). Its answer starts with
          // the mention it asked for (API-76).
          const delivered = yield* outcome._tag === "Answered"
            ? request.plugin !== undefined && outcome.text.trim() === silent
              ? Effect.succeed("posted" as const)
              : mentioned(
                  chat,
                  format,
                  yield* mentionOf(request),
                  outcome.text,
                  {
                    replyTo: reply,
                    answer: ids,
                  },
                )
            : post(chat, format, Messages.stopped(format, at - turn.at))
          // An answer for a thread that no longer exists ends the turn `ThreadGone`, which posts nothing (FAIL-44,
          // FAIL-64).
          if (delivered === "gone" && outcome._tag === "Answered") {
            const reason: Failed.Reason = { _tag: "ThreadGone" }
            // The row holds the turn's end already, so a rewrite that fails leaves it `Answered` and the request
            // may be answered.
            yield* Sessions.ended({
              key: turn.key,
              outcome: "failed",
              failure: recorded(reason),
              at,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("A gone thread could not be recorded", cause),
              ),
            )
            yield* TurnLog.failed(fields, reason._tag)
            yield* threadGone(request)
            return { _tag: "Failed", reason } as const
          }
          if (delivered === "failed" && outcome._tag === "Answered") {
            yield* Sessions.tell(live.id, {
              turn: turn.id,
              outcome: "answered",
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  "An unposted answer could not be recorded",
                  cause,
                ),
              ),
            )
          }
          yield* TurnLog.ended(
            fields,
            outcome._tag === "Answered" ? "answered" : "stopped",
          )
          return outcome
        })

        /**
         * A message that arrives while a turn runs. It is passed to `steer` and waits until a batch that carries it
         * is stored. `next` says that the turn ended first, and then the message starts the next turn itself.
         */
        const steer = Effect.fnUntraced(function* (
          turn: Turn,
          request: Request,
        ) {
          const message = request.message!
          // A message that was on its way into a turn when the turn was stopped is dropped with the ones that waited.
          const arrived = !turn.stopped
          const missed = Effect.map(
            Deferred.await(turn.ended),
            (): Outcome | "next" =>
              arrived && turn.stopped ? { _tag: "Dropped" } : "next",
          )
          const live = turn.closing
            ? undefined
            : yield* Deferred.await(turn.open)
          if (live === undefined) return yield* missed
          const chat = yield* chats.get(request.connection)
          const format = yield* chats.format(request.connection)
          const read = yield* Attachments.read({
            chat,
            format,
            message,
            attachments: request.attachments,
            directory: live.directory,
            asImages: false,
          })
          yield* tell(chat, format, request, read)
          if (turn.closing) return yield* missed
          const entry: Steer = {
            key: request.key,
            text: read.text,
            message,
            done: Deferred.makeUnsafe(),
            fiber: undefined,
          }
          turn.steers.push(entry)
          entry.fiber = yield* Effect.forkIn(
            live.agent.steer(read.text),
            live.scope,
          )
          return yield* Deferred.await(entry.done)
        })

        /** Stops the turn of a state, when one runs, and says whether one did. The turn unwinds on its own. */
        const interrupt = Effect.fnUntraced(function* (turn: Turn | undefined) {
          if (turn === undefined || turn.closing) return false
          turn.stopped = true
          if (turn.fiber !== undefined) {
            yield* Effect.forkIn(Fiber.interrupt(turn.fiber), scope)
          }
          return true
        })

        /** The rest of a `/new`, after the entity has accepted it. */
        const reset = Effect.fnUntraced(function* (
          old: State,
          payload: {
            readonly by: string
            readonly connection: string
            readonly kind: Sessions.Kind
            readonly message: string
            readonly at: number
          },
        ) {
          if (old.ready !== undefined) yield* Deferred.await(old.ready)
          const chat = yield* chats.get(payload.connection)
          const format = yield* chats.format(payload.connection)
          // A running turn is stopped first, and it posts its own notice before the new session's.
          if (old.turn !== undefined) {
            const turn = old.turn
            turn.reset = true
            yield* interrupt(turn)
            yield* Deferred.await(turn.ended)
          }
          // Closing the old executor stops the background processes it started.
          if (old.live !== undefined)
            yield* Scope.close(old.live.scope, Exit.void)
          const previous = yield* Sessions.current(key)
          const id = yield* Sessions.renew(key, payload.kind, {
            id: payload.message,
            at: payload.at,
          })
          yield* post(chat, format, Messages.newSession(format))
          // The new session's first turn waits for the hooks each plugin queued ahead of `Reset`, and for `Reset`
          // itself, each inside its budget (API-59, API-61, SWAP-150).
          if (previous !== undefined) {
            const hooks = yield* plugins.onSession({
              _tag: "Reset",
              previous: {
                id: previous.id,
                thread,
                kind: previous.kind ?? "thread",
                directory: resolve(volume.sessions, previous.id),
              },
              session: {
                id,
                thread,
                kind: payload.kind,
                directory: resolve(volume.sessions, id),
              },
            })
            yield* hooks
          }
          yield* Queue.ran("/new", Queue.caller(undefined), "changed", {
            session: id,
          })
        })

        /**
         * A stored request whose chat message this image cannot decode, which a deploy that changes effect/chat's
         * encoding leaves (SES-152, SES-205). It fails as `Internal` with the failed-turn message and is answered, so
         * it does not block the thread and is not tried again.
         */
        const undecodable = Effect.fnUntraced(function* (
          payload: Message,
          cause: Cause.Cause<unknown>,
        ) {
          const reason: Failed.Reason = {
            _tag: "Internal",
            message: Messages.firstLine(Cause.pretty(cause)),
          }
          const at = Date.now()
          const session = (yield* Sessions.current(key))?.id
          const ended = yield* Sessions.undecodable({
            key: payload.key,
            turn: Sessions.turnId(),
            session,
            detail: Failed.detail(reason),
            at,
          })
          if (ended !== undefined) {
            // A stored request is delivered as the daemon boots, before the platform may have answered.
            yield* chats.ready(payload.connection)
            const chat = yield* chats.get(payload.connection)
            const format = yield* chats.format(payload.connection)
            // The status message a cut start left behind gets one attempt at its removal (DIS-95).
            if (ended.status !== undefined) {
              yield* StatusMessage.discard(chat, thread, ended.status)
            }
            yield* post(
              chat,
              format,
              Messages.failedTurn(format, 0, reason, ended.turn),
            )
            yield* TurnLog.failed(
              {
                session: ended.session,
                turn: ended.turn,
                duration: 0,
                usage: Sessions.noUsage,
                reconciled: 0,
              },
              reason._tag,
              cause,
            )
          }
          return { _tag: "Failed", reason } as const
        })

        /**
         * Runs one turn of a request on the session as it is now, and queues the plugins' `afterTurn` for it however
         * it ended, a stop included (API-54, SES-69). A compaction in it queues `Compacted` after that (API-60).
         */
        const runTurn = Effect.fnUntraced(function* (
          own: State,
          request: Request,
        ) {
          const turn: Turn = {
            id: Sessions.turnId(),
            key: request.key,
            at: Date.now(),
            open: Deferred.makeUnsafe(),
            ended: Deferred.makeUnsafe(),
            steers: [],
            usage: Sessions.noUsage,
            earlier: Sessions.noUsage,
            fiber: undefined,
            stopped: false,
            reset: false,
            closing: false,
            known: undefined,
            prompted: false,
            size: 1,
            resumed: false,
            status: undefined,
            settings: models.settings(),
            steps: TurnLog.steps(),
            steered: [],
            initial: undefined,
            compacted: false,
            public: undefined,
          }
          own.turn = turn
          yield* take(request.key)
          const outcome = yield* run(own, turn, request).pipe(
            Effect.catchCause(failed(turn, own, request)),
            Effect.ensuring(close(own, turn)),
          )
          if (outcome !== unrecorded && turn.public !== undefined) {
            yield* ended(own, turn, turn.public, outcome)
          }
          return outcome
        })

        /** Hands a turn that ended to the plugins, off the reply path. */
        const ended = Effect.fnUntraced(function* (
          own: State,
          turn: Turn,
          publicTurn: PublicSession.Turn,
          outcome: Outcome,
        ) {
          const live = own.live
          const initial = new Set(turn.initial ?? [])
          // Built after the reconcile, so it has what only the reconcile wrote (API-107).
          const appended =
            live === undefined || turn.initial === undefined
              ? []
              : live.agent.history.current.content.filter(
                  (message) =>
                    message.role !== "system" && !initial.has(message),
                )
          yield* plugins.afterTurn({
            turn: publicTurn,
            steers: turn.steered,
            outcome: publicOutcome(outcome),
            appended,
          })
          if (turn.compacted) {
            // clanka dropped the update messages when it compacted, so the next turn renders the system prompt again
            // with the chunks folded in. The row forgets it too, for a restart before that turn (SES-121, SWAP-25, SWAP-36).
            if (live !== undefined) {
              live.frozen = undefined
              live.unsaved = false
              yield* Sessions.thaw(live.id)
            }
            own.hooks = yield* plugins.onSession({
              _tag: "Compacted",
              session: publicTurn.session,
            })
          }
        })

        return Session.of({
          message: ({ payload }) =>
            Effect.gen(function* () {
              // The turn that ran when the message arrived, read before anything waits, so that a `/stop` or a
              // `/new` that arrives behind it still finds the message waiting on that turn.
              let joined = state.turn
              if (joined?.stopped === true) joined = undefined
              const decoded = decodeChatMessage(payload.message)
              const duplicate = Logger.event(
                "message.ignored",
                "A message was ignored",
                {
                  reason: "duplicate",
                  author: Exit.isSuccess(decoded)
                    ? decoded.value.author.id
                    : "unknown",
                  connection: payload.connection,
                },
              )
              // A request whose turn already ended is answered from the row, and starts nothing.
              const row = yield* Sessions.turn(payload.key)
              if (row !== undefined && row.outcome !== null) {
                yield* duplicate
                const reply: Outcome =
                  row.outcome === "answered"
                    ? { _tag: "Answered", text: "" }
                    : row.outcome === "stopped"
                      ? { _tag: "Stopped" }
                      : {
                          _tag: "Failed",
                          reason: Failed.fromRow(
                            row.failure,
                            row.failure_detail,
                          ),
                        }
                return reply
              }
              // A message that joined a turn and is delivered again has nothing left to do.
              if (yield* Sessions.steered(payload.key)) {
                yield* duplicate
                return { _tag: "Steered" } as const
              }
              // A stored message that this image cannot read ends its request at once, and is not tried again.
              // A cut turn's request that does not decode still lets the thread's other requests go.
              if (Exit.isFailure(decoded)) {
                yield* take(payload.key)
                return yield* undecodable(payload, decoded.cause)
              }
              const request: Request = {
                key: payload.key,
                connection: payload.connection,
                message: decoded.value,
                attachments: payload.attachments,
                plugin: undefined,
              }
              if (first !== undefined && first.key !== payload.key) {
                yield* Deferred.await(first.taken)
              }
              while (true) {
                const own = state
                const running = joined ?? own.turn
                joined = undefined
                if (running === undefined) {
                  // No turn starts in the wait of a graceful stop. The request stays unanswered for the next start.
                  if (stopping.stopping()) return yield* Effect.never
                  const outcome = yield* runTurn(own, request)
                  // A turn whose end could not be written leaves its request unprocessed, as a crash would, and
                  // cluster delivers it at the next start (FAIL-135). The turn is closed, so the thread goes on.
                  if (outcome === unrecorded) return yield* Effect.never
                  return outcome
                }
                const outcome = yield* steer(running, request)
                if (outcome !== "next") return outcome
              }
            }).pipe(Effect.ensuring(take(payload.key)), Effect.orDie),
          plugin: ({ payload }) =>
            Effect.gen(function* () {
              // A request whose turn already ended is answered from the row, and starts nothing.
              const row = yield* Sessions.turn(payload.key)
              if (row !== undefined && row.outcome !== null) {
                return row.outcome === "answered"
                  ? ({ _tag: "Answered", text: "" } as const)
                  : row.outcome === "stopped"
                    ? ({ _tag: "Stopped" } as const)
                    : ({
                        _tag: "Failed",
                        reason: Failed.fromRow(row.failure, row.failure_detail),
                      } as const)
              }
              const request: Request = {
                key: payload.key,
                connection: payload.connection,
                message: undefined,
                attachments: [],
                plugin: {
                  name: payload.plugin,
                  label: payload.label,
                  prompt: payload.prompt,
                  mention: payload.mention,
                },
              }
              if (first !== undefined && first.key !== payload.key) {
                yield* Deferred.await(first.taken)
              }
              // A thread with no session gets one for the turn, of the kind effect/chat reads for it. A thread the
              // platform does not have ends the turn `ThreadGone` (API-116 to API-118).
              if ((yield* Sessions.current(key)) === undefined) {
                yield* chats.ready(payload.connection)
                const chat = yield* chats.get(payload.connection)
                const info = yield* Effect.exit(chat.getThread(thread))
                if (Exit.isFailure(info) && Post.notFound(info.cause)) {
                  yield* take(payload.key)
                  yield* threadGone(request)
                  return {
                    _tag: "Failed",
                    reason: { _tag: "ThreadGone" },
                  } as const
                }
                const kind = Exit.isSuccess(info) ? info.value.kind : "thread"
                yield* Sessions.open(
                  key,
                  kind === "direct" || kind === "channel" ? kind : "thread",
                )
              }
              // A plugin's turn waits for the session to be idle and never steers (API-72). Owners' messages that
              // waited on the same turn take the session first (SES-164).
              while (true) {
                const own = state
                if (own.turn !== undefined) {
                  yield* Deferred.await(own.turn.ended)
                  yield* Effect.yieldNow
                  continue
                }
                if (stopping.stopping()) return yield* Effect.never
                const outcome = yield* runTurn(own, request)
                if (outcome === unrecorded) return yield* Effect.never
                return outcome
              }
            }).pipe(
              // Every outcome the handler returns, the early ones for a thread that is gone and a turn that already
              // ended included, reaches a caller waiting in this process here, and not from cluster's reply alone,
              // which may never be saved (SES-125, API-100).
              Effect.tap((outcome) =>
                Effect.sync(() => support.ended(payload.key, outcome)),
              ),
              Effect.ensuring(take(payload.key)),
              Effect.orDie,
            ),
          stop: ({ payload }) =>
            Effect.gen(function* () {
              if (yield* interrupt(state.turn)) return { stopped: true }
              const format = yield* chats.format(payload.connection)
              yield* post(
                yield* chats.get(payload.connection),
                format,
                Messages.nothingRunning(format),
              )
              return { stopped: false }
            }),
          reset: ({ payload }) =>
            Effect.gen(function* () {
              // From here on a message belongs to the new session, whatever is left to do for the old one.
              const old = state
              const ready = Deferred.makeUnsafe<void>()
              state = {
                live: undefined,
                turn: undefined,
                ready,
                hooks: undefined,
              }
              yield* reset(old, payload).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("A reset could not be finished", cause),
                ),
                Effect.ensuring(Deferred.succeed(ready, undefined)),
                Effect.forkIn(scope),
              )
            }),
        })
      }),
      {
        maxIdleTime: timings.sessionIdle,
        concurrency: "unbounded",
        // A defect that escapes a handler fails that one request, and the activation carries on (SES-20).
        disableFatalDefects: true,
      },
    )
  }),
)
