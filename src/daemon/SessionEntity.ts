import { createHash } from "node:crypto"
import { resolve } from "node:path"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import type { TaskHandle } from "clanka/AgentTools"
import * as Compaction from "clanka/Compaction"
import {
  Cause,
  Context,
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
import type { LanguageModel, Model as AiModel } from "effect/ai"
import { Prompt } from "effect/ai"
import {
  Chat,
  ChatError,
  ChatEvent,
  ChatMarkdown,
  ChatMessage,
  ChatThread,
} from "effect/chat"
import { ClusterSchema, Entity, type Sharding } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { SqlClient } from "effect/sql"
import * as Messages from "../Messages.ts"
import { Timings } from "../Timings.ts"
import * as Attachments from "./Attachments.ts"
import { Chats, type ChatService } from "./Chats.ts"
import * as Failed from "./Failed.ts"
import * as Logger from "./Logger.ts"
import * as Queue from "./Queue.ts"
import * as Sessions from "./Sessions.ts"
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

/** What became of a post: it reached the thread, the thread is gone, or it failed otherwise. */
type Posting = "posted" | "gone" | "failed"

/** Whether a post failed because the platform does not have the thread (FAIL-44). */
const gone = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some((reason) => {
    if (reason._tag !== "Fail") return false
    const error = reason.error
    const chat =
      error instanceof ChatMarkdown.ChatMarkdownError &&
      error.cause._tag === "Chat"
        ? error.cause.error
        : error
    return ChatError.isChatError(chat) && chat.reason._tag === "NotFound"
  })

/** A request with its chat message decoded. */
interface Request {
  readonly key: string
  readonly connection: string
  readonly message: ChatMessage.ChatMessage
  readonly attachments: ReadonlyArray<string>
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

/** The model a turn runs on, when the environment names one: the setting as it was given, and its layer. */
export class Model extends Context.Service<
  Model,
  Option.Option<{
    readonly name: string
    readonly layer: Layer.Layer<
      LanguageModel.LanguageModel | AiModel.ProviderName | AiModel.ModelName
    >
  }>
>()("chad/SessionEntity/Model") {}

/**
 * Whether the daemon is stopping. A request that would start a turn in the wait of a graceful stop starts none, and is
 * left for the next start (SES-201).
 */
export const Stopping = Context.Reference<{ readonly stopping: () => boolean }>(
  "chad/SessionEntity/Stopping",
  { defaultValue: () => ({ stopping: () => false }) },
)

/** The system prompt as chad renders it, which is what a session freezes and what its fingerprint is taken of. */
export const system = (options: {
  readonly toolInstructions: string
  readonly agentsMd: string
}) => `You are a world-class software engineer: precise and efficient.

${options.toolInstructions}

${options.agentsMd}
`

/** A session as it is held in memory: its Agent, its executor and what chad has stored of it. */
interface Live {
  readonly id: string
  /** The scope of the Agent and its executor, which a `/new` closes. */
  readonly scope: Scope.Closeable
  readonly agent: Agent.Agent
  readonly directory: string
  /** The ids the session's log lines carry, whose turn is the one running (FAIL-25, FAIL-26). */
  readonly ids: Logger.SessionLogIds
  /** The system prompt the session last sent, with the fingerprint of what chad rendered for it. */
  frozen: { readonly system: string; readonly fingerprint: string } | undefined
  /** Whether the frozen prompt has changed since it was stored. */
  unsaved: boolean
}

/** An owner's message that waits to steer the running turn. */
interface Steer {
  readonly key: string
  readonly text: string
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
}

/** What the entity holds for the thread's current session. A `/new` puts a fresh one in its place. */
interface State {
  live: Live | undefined
  turn: Turn | undefined
  /** Resolves when the `/new` that made this state has finished. No turn starts before it. */
  readonly ready: Deferred.Deferred<void> | undefined
}

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
        const model = yield* Model
        const chats = yield* Chats
        const fs = yield* FileSystem.FileSystem
        const services = yield* Effect.context<
          Sharding.Sharding | Entity.CurrentAddress | SqlClient.SqlClient
        >()
        let state: State = {
          live: undefined,
          turn: undefined,
          ready: undefined,
        }
        const stopping = yield* Stopping
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
        const post = (chat: ChatService, markdown: string) =>
          ChatMarkdown.post(thread, markdown).pipe(
            Effect.provideService(Chat.Chat, chat),
            Effect.as<Posting>("posted"),
            Effect.catchCause((cause) =>
              Effect.logError("A message could not be posted", cause).pipe(
                Effect.as<Posting>(gone(cause) ? "gone" : "failed"),
              ),
            ),
          )

        /**
         * Tells the owner about the files of a message that chad skipped, once for a message, though a message that
         * waited to steer a turn and then starts the next one has its files read twice.
         */
        const told = new Set<string>()
        const tell = Effect.fnUntraced(function* (
          chat: ChatService,
          request: Request,
          read: Attachments.Read,
        ) {
          if (read.notices.length === 0 || told.has(request.key)) return
          told.add(request.key)
          for (const notice of read.notices) yield* post(chat, notice)
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
          const track = (task: TaskHandle) =>
            Effect.gen(function* () {
              tasks.set(task.id, task.kind)
              yield* record
              yield* Entity.keepAlive(true)
              yield* task.await.pipe(
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
          const ids: Logger.SessionLogIds = { session: id, turn: undefined }
          const built = yield* Layer.buildWithScope(
            AgentExecutor.layerLocal({ directory }).pipe(
              Layer.provide(Spawner.layer(id, volume.home)),
            ),
            own,
          ).pipe(Effect.provideService(Logger.CurrentLogIds, ids))
          const inner = Context.get(built, AgentExecutor.AgentExecutor)
          const executor = AgentExecutor.AgentExecutor.of({
            capabilities: inner.capabilities,
            executeUnsafe: inner.executeUnsafe.bind(inner),
            renderEnvironment: inner.renderEnvironment,
            // clanka reports a script's failure through the logger, with the script's own output as the console,
            // and chad's logger prints such a line into the script's output (FAIL-23).
            execute: (options) =>
              inner.execute({
                ...options,
                onTask: (task) =>
                  Effect.andThen(
                    track(task),
                    options.onTask?.(task) ?? Effect.void,
                  ),
              }),
          })
          const agent = yield* Agent.make.pipe(
            Effect.provideService(AgentExecutor.AgentExecutor, executor),
            Effect.provideService(Scope.Scope, own),
            Effect.provideService(Logger.CurrentLogIds, ids),
          )
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
            directory,
            ids,
            frozen:
              row.system === null || row.fingerprint === null
                ? undefined
                : { system: row.system, fingerprint: row.fingerprint },
            unsaved: false,
          }
          return live
        })

        /**
         * The `system` function of a `send`. A session keeps the prompt it sent, and sends that text again for as long
         * as the fingerprint of what chad would render now is the one it was frozen with.
         */
        const frozen =
          (live: Live) =>
          (options: {
            readonly toolInstructions: string
            readonly agentsMd: string
          }) => {
            const rendered = system(options)
            const fingerprint = createHash("sha256")
              .update(rendered)
              .digest("hex")
            if (live.frozen?.fingerprint !== fingerprint) {
              live.frozen = { system: rendered, fingerprint }
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
        ) {
          // A resumed start sends the restart note in place of the owner's message when the stored history holds that
          // message. When a kill came before it was stored, the message goes first and the note after it (SES-161).
          const held = turn.resumed && (yield* Sessions.holds(turn.key))
          const read = held
            ? undefined
            : yield* Attachments.read({
                chat,
                message: request.message,
                attachments: request.attachments,
                directory: live.directory,
                asImages: true,
              })
          if (read !== undefined) yield* tell(chat, request, read)
          // What chad posted in the thread since the last answer the owner read goes ahead of the prompt, in one update
          // message that the system prompt does not change for (FAIL-125, FAIL-127, FAIL-131).
          const pending = yield* Sessions.updates(live.id)
          const text = Messages.update(pending.lines)
          const update =
            text === undefined || pending.last === undefined
              ? []
              : [
                  Prompt.userMessage({
                    content: [Prompt.textPart({ text })],
                    options: Sessions.updateOf(pending.last),
                  }),
                ]
          const note = Prompt.userMessage({
            content: [Prompt.textPart({ text: Messages.restartNote() })],
          })
          const messages = [
            ...update,
            ...(read === undefined
              ? [note]
              : [
                  Attachments.prompt(read, Sessions.promptOf(turn.key)),
                  ...(turn.resumed ? [note] : []),
                ]),
          ]
          turn.size = messages.length
          const known = new Set(live.agent.history.current.content)
          turn.known = known
          const output = yield* live.agent.send({
            prompt:
              read === undefined && update.length === 0
                ? Messages.restartNote()
                : Prompt.fromMessages(messages),
            system: frozen(live),
          })
          yield* saveFrozen(live)
          const steps = TurnLog.steps()
          const ids = { session: live.id, turn: turn.id }
          return yield* output.pipe(
            Stream.runForEach((part) =>
              Effect.gen(function* () {
                yield* TurnLog.step(steps, ids, part)
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
                  for (const message of part.messages) known.add(message)
                  yield* Sessions.replace(
                    live.id,
                    part.messages,
                    live.agent.environment.current,
                  )
                } else if (part._tag === "Usage") {
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
            Effect.as(""),
            Effect.catchTag("AgentFinished", (finished) =>
              Effect.succeed(finished.summary),
            ),
          )
        }, Effect.scoped)

        /** The model's part with its model, and with clanka's summarizer on the same one. */
        const ask = Effect.fnUntraced(function* (
          live: Live,
          turn: Turn,
          request: Request,
          chat: ChatService,
        ) {
          const chosen = yield* Effect.fromOption(model)
          return yield* converse(live, turn, request, chat).pipe(
            Effect.provide(
              Layer.merge(
                chosen.layer,
                Compaction.layerSummarizerModel(chosen.layer),
              ),
            ),
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
            const reply: Outcome | "next" =
              turn.stopped || turn.reset ? { _tag: "Dropped" } : "next"
            for (const steer of waiting) {
              Deferred.doneUnsafe(steer.done, Effect.succeed(reply))
            }
            Deferred.doneUnsafe(turn.ended, Effect.void)
          })

        /** Whether a reason's turn posts the failed-turn message. The others post a message of their own or nothing. */
        const posted = (reason: Failed.Reason): reason is Messages.Posted =>
          reason._tag === "ModelError" || reason._tag === "Internal"

        /** What a failed turn's row records of its reason: the tag and the whole reason (STO-76). */
        const recorded = (reason: Failed.Reason) => ({
          tag: reason._tag,
          detail: Failed.detail(reason),
        })

        /** Ends a turn that a defect outside the model's part cut: its row, the failed-turn message and its log line. */
        const failed = (turn: Turn, own: State, connection: string) =>
          Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
            const at = Date.now()
            const reason = Failed.classify(cause)
            const session = own.live?.id
            yield* Sessions.ended({
              key: turn.key,
              outcome: "failed",
              failure: recorded(reason),
              at,
              tell:
                session === undefined ? undefined : { session, turn: turn.id },
            }).pipe(Effect.ignore)
            if (posted(reason)) {
              yield* chats.get(connection).pipe(
                Effect.flatMap((chat) =>
                  post(
                    chat,
                    Messages.failedTurn(at - turn.at, reason, turn.id),
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
            return { _tag: "Failed", reason } as const
          })

        /** One turn, from the request that takes the session to the reply. */
        const run = Effect.fnUntraced(function* (
          own: State,
          turn: Turn,
          request: Request,
        ) {
          const chat = yield* chats.get(request.connection)
          if (own.ready !== undefined) yield* Deferred.await(own.ready)
          const built = yield* Effect.exit(
            Effect.gen(function* () {
              own.live ??= yield* start()
              const live = own.live
              const started = yield* Sessions.started({
                key: turn.key,
                turn: turn.id,
                session: live.id,
                model: Option.getOrUndefined(model)?.name,
                at: turn.at,
              })
              turn.id = started.turn
              turn.usage = turn.earlier = started.earlier
              turn.resumed = started.starts > 1
              return { live, started }
            }),
          )
          if (Exit.isFailure(built)) {
            return yield* failed(turn, own, request.connection)(built.cause)
          }
          const { live, started } = built.value
          const ids = { session: live.id, turn: turn.id }
          // A line the session logs from here until the turn closes carries the turn's id (FAIL-26).
          live.ids.turn = turn.id
          // After two starts that a kill ended, the model does not run again (SES-106).
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
            yield* post(chat, Messages.gaveUp(turn.id))
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
          // The first start writes `turn.started`, and each later one `turn.resumed` (FAIL-326).
          if (turn.resumed) {
            yield* TurnLog.resumed(ids, "message", started.starts)
          } else {
            yield* TurnLog.started(ids, "message")
          }
          Deferred.doneUnsafe(turn.open, Effect.succeed(live))

          // The model's part runs in a fiber of its own, which is what a stop interrupts. A turn that was stopped
          // while it was starting never reaches the model.
          let exit: Exit.Exit<string, unknown> = Exit.succeed("")
          if (!turn.stopped) {
            const fiber = yield* Effect.forkChild(
              ask(live, turn, request, chat),
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
            return yield* failed(turn, own, request.connection)(end.cause)

          const { outcome, reconciled, at } = end.value
          const fields: TurnLog.End = {
            ...ids,
            duration: at - turn.at,
            usage: turn.usage,
            reconciled,
          }
          if (outcome._tag === "Failed") {
            if (posted(outcome.reason)) {
              yield* post(
                chat,
                Messages.failedTurn(at - turn.at, outcome.reason, turn.id),
              )
            }
            yield* TurnLog.failed(
              fields,
              outcome.reason._tag,
              Exit.isFailure(exit) ? exit.cause : undefined,
            )
            return outcome
          }
          // The answer goes out through the connection the message arrived on. An answer that could not be posted
          // leaves the turn `Answered`, because the history holds it (FAIL-51), and the model is told that the owner
          // has not read it (FAIL-129).
          const delivered = yield* post(
            chat,
            outcome._tag === "Answered"
              ? outcome.text
              : Messages.stopped(at - turn.at),
          )
          // An answer for a thread that no longer exists ends the turn `ThreadGone`, which posts nothing (FAIL-44,
          // FAIL-64).
          if (delivered === "gone" && outcome._tag === "Answered") {
            const reason: Failed.Reason = { _tag: "ThreadGone" }
            yield* Sessions.ended({
              key: turn.key,
              outcome: "failed",
              failure: recorded(reason),
              at,
            })
            yield* TurnLog.failed(fields, reason._tag)
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
          const read = yield* Attachments.read({
            chat,
            message: request.message,
            attachments: request.attachments,
            directory: live.directory,
            asImages: false,
          })
          yield* tell(chat, request, read)
          if (turn.closing) return yield* missed
          const entry: Steer = {
            key: request.key,
            text: read.text,
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
          const id = yield* Sessions.renew(key, payload.kind, {
            id: payload.message,
            at: payload.at,
          })
          yield* post(chat, Messages.newSession())
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
            yield* post(
              yield* chats.get(payload.connection),
              Messages.failedTurn(0, reason, ended.turn),
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
              // A turn whose prompt the volume shows neither as stored nor as not stored is held: its delivery stays
              // unanswered and starts nothing, and the thread's other requests go on, until Tim rules on it (STO-211).
              // Such a request that does not decode fails with the defect cluster gave it before the entity decoded
              // the message itself, and nothing else.
              if (
                row !== undefined &&
                (yield* Sessions.unproven(payload.key))
              ) {
                yield* take(payload.key)
                if (Exit.isFailure(decoded)) {
                  return yield* Effect.die(Cause.squash(decoded.cause))
                }
                return yield* Effect.never
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
                  const turn: Turn = {
                    id: Sessions.turnId(),
                    key: payload.key,
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
                  }
                  own.turn = turn
                  yield* take(payload.key)
                  return yield* run(own, turn, request).pipe(
                    Effect.catchCause(failed(turn, own, request.connection)),
                    Effect.ensuring(close(own, turn)),
                  )
                }
                const outcome = yield* steer(running, request)
                if (outcome !== "next") return outcome
              }
            }).pipe(Effect.ensuring(take(payload.key)), Effect.orDie),
          stop: ({ payload }) =>
            Effect.gen(function* () {
              if (yield* interrupt(state.turn)) return { stopped: true }
              yield* post(
                yield* chats.get(payload.connection),
                Messages.nothingRunning(),
              )
              return { stopped: false }
            }),
          reset: ({ payload }) =>
            Effect.gen(function* () {
              // From here on a message belongs to the new session, whatever is left to do for the old one.
              const old = state
              const ready = Deferred.makeUnsafe<void>()
              state = { live: undefined, turn: undefined, ready }
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
