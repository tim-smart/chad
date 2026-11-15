// PROTOTYPE for "The plugin swap run with live sessions" (TIM-552). Throwaway.
//
// The host from "The Session entity run on SingleRunner and SQLite" (TIM-543), cut down and
// rewired: a Session entity and a Timer entity on effect cluster's SingleRunner over one SQLite
// file, ChatTest in place of Discord. What is new here:
//   - every session runs real clanka (Agent.makeWith) on a scripted LanguageModel
//   - plugins are real bundles loaded by chad/plugins.ts, and a session's Agent is rebuilt at the
//     start of its next turn when the plugin generation moved
//   - plugin tool handlers reach clanka only through the wrapper in chad/plugins.ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Agent, AgentExecutor, McpServers } from "clanka"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Chat from "effect/chat/Chat"
import * as ChatEvent from "effect/chat/ChatEvent"
import * as ChatHandler from "effect/chat/ChatHandler"
import * as ChatTest from "effect/chat/ChatTest"
import * as ChatThread from "effect/chat/ChatThread"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as DeliverAt from "effect/cluster/DeliverAt"
import * as Entity from "effect/cluster/Entity"
import { EntityAddress } from "effect/cluster/EntityAddress"
import * as MessageStorage from "effect/cluster/MessageStorage"
import * as Sharding from "effect/cluster/Sharding"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as PrimaryKey from "effect/PrimaryKey"
import * as Rpc from "effect/rpc/Rpc"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { log } from "./log.ts"
import * as Mcp from "./mcp.ts"
import * as Plugins from "./plugins.ts"

const env = process.env
export const DB = env.PROTO_DB ?? "PROTOTYPE-wipe-me.sqlite"
export const WORK = env.PROTO_WORK ?? "work"
export const OWNER = "owner-1"
const PLATFORM = "test"

// --- the SQLite tables chad owns, next to cluster's own ---------------------

const TablesLive = Layer.effectDiscard(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS sessions (thread TEXT PRIMARY KEY, id TEXT NOT NULL, environment TEXT)`
  yield* sql`CREATE TABLE IF NOT EXISTS session_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, message TEXT NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS turns (key TEXT PRIMARY KEY, id TEXT NOT NULL, thread TEXT NOT NULL, origin TEXT NOT NULL, starts INTEGER NOT NULL DEFAULT 0, cuts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new', outcome TEXT)`
  yield* sql`CREATE TABLE IF NOT EXISTS timers (plugin TEXT NOT NULL, name TEXT NOT NULL, thread TEXT NOT NULL, prompt TEXT NOT NULL, next_run INTEGER NOT NULL, PRIMARY KEY (plugin, name))`
}).pipe(Effect.orDie))

// --- protocol ---------------------------------------------------------------

export const Outcome = Schema.Union([
  Schema.TaggedStruct("Answered", { text: Schema.String }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  Schema.TaggedStruct("Stopped", {}),
  Schema.TaggedStruct("Steered", {}),
  Schema.TaggedStruct("Dropped", {})
])
export type Outcome = typeof Outcome.Type

export class Incoming extends Schema.Class<Incoming>("proto/Incoming")({
  key: Schema.String,
  thread: Schema.String,
  text: Schema.String,
  userId: Schema.String,
  sentAt: Schema.Number
}) {
  [PrimaryKey.symbol]() {
    return this.key
  }
}

export class PluginTurn extends Schema.Class<PluginTurn>("proto/PluginTurn")({
  key: Schema.String,
  thread: Schema.String,
  prompt: Schema.String,
  plugin: Schema.String,
  label: Schema.String,
  sentAt: Schema.Number
}) {
  [PrimaryKey.symbol]() {
    return this.key
  }
}

export const Session = Entity.make("Session", [
  Rpc.make("message", { payload: Incoming, success: Outcome }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("pluginTurn", { payload: PluginTurn, success: Outcome }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("stop", { payload: Schema.Struct({ by: Schema.String }), success: Schema.Struct({ stopped: Schema.Boolean }) })
])

export class Fire extends Schema.Class<Fire>("proto/Fire")({
  plugin: Schema.String,
  name: Schema.String,
  at: Schema.Number
}) {
  [PrimaryKey.symbol]() {
    return String(this.at)
  }
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at)
  }
}

export const Timer = Entity.make("Timer", [
  Rpc.make("fire", { payload: Fire }).annotate(ClusterSchema.Persisted, true)
])

const thread = (id: string) => ChatThread.make(PLATFORM, id)
const RESTART_NOTE =
  "[chad restarted while this turn was running. A script that was cut off may already have had its side effects. Check before you repeat anything, then finish the request above.]"

// --- the scripted model -------------------------------------------------------
//
// It reads its behaviour from the last user message that carries PLAN:{"steps":[...]}.
// Each step is a script. Once every step has a tool result it answers with those results, or,
// for a sub-agent ("complete": true), calls taskComplete with them.

const messageText = (message: Prompt.Message): string =>
  typeof message.content === "string"
    ? message.content
    : (message.content as ReadonlyArray<any>).map((part) => (part.type === "text" ? part.text : "")).join("")

let modelCalls = 0
const ScriptedModel = Layer.unwrap(Effect.gen(function*() {
  const languageModel = yield* LanguageModel.make({
    generateText: () => Effect.die("unexpected generateText call"),
    streamText: (options) => {
      const messages = options.prompt.content
      let at = -1
      let plan: { steps: Array<string>; complete?: boolean } = { steps: [] }
      for (let i = messages.length - 1; i >= 0 && at === -1; i--) {
        if (messages[i].role !== "user") continue
        const text = messageText(messages[i])
        // A task notification quotes the child's prompt, plan and all. It is not a plan for this agent.
        if (!text.includes("PLAN:") || text.trimStart().startsWith("<")) continue
        try {
          plan = JSON.parse(text.slice(text.indexOf("PLAN:") + 5).split("\n")[0])
          at = i
        } catch {}
      }
      const call = ++modelCalls
      if (at === -1) {
        return Stream.make<Array<any>>({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "no plan" }, { type: "text-end", id: "t" }) as any
      }
      const results: Array<string> = []
      for (const message of messages.slice(at + 1)) {
        if (message.role !== "tool") continue
        for (const part of message.content as ReadonlyArray<any>) if (part.type === "tool-result") results.push(String(part.result))
      }
      if (results.length < plan.steps.length) {
        return Stream.make({ type: "tool-call", id: "call-" + call, name: "execute", params: { script: plan.steps[results.length] } }) as any
      }
      const answer = "RESULTS " + JSON.stringify(results)
      if (plan.complete) {
        return Stream.make({ type: "tool-call", id: "call-" + call, name: "execute", params: { script: "await taskComplete(" + JSON.stringify(answer) + ")" } }) as any
      }
      return Stream.make<Array<any>>({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: answer }, { type: "text-end", id: "t" }) as any
    }
  })
  return Layer.mergeAll(
    Layer.succeed(LanguageModel.LanguageModel, languageModel),
    Layer.succeed(Model.ProviderName, "scripted"),
    Layer.succeed(Model.ModelName, "scripted")
  )
}))

// --- core tools: how a script and a scenario meet -----------------------------

const CoreTools = Toolkit.make(
  Tool.make("mark", {
    description: "Prototype: write a line to the event log.",
    parameters: Schema.Struct({ label: Schema.String }),
    success: Schema.String
  }),
  Tool.make("pause", {
    description: "Prototype: wait this long.",
    parameters: Schema.Struct({ ms: Schema.Number }),
    success: Schema.String
  }),
  Tool.make("hold", {
    description: "Prototype: wait until the scenario releases this label.",
    parameters: Schema.Struct({ label: Schema.String }),
    success: Schema.String
  })
)
const latches = new Map<string, Deferred.Deferred<void>>()
const latch = (label: string) => {
  let d = latches.get(label)
  if (d === undefined) latches.set(label, d = Deferred.makeUnsafe<void>())
  return d
}
/** The scenario's side of hold(label). */
export const release = (label: string) => Effect.sync(() => void Deferred.doneUnsafe(latch(label), Exit.void))

const MessageJson = Schema.toCodecJson(Prompt.Message)
const encodeMessage = Schema.encodeSync(MessageJson)
const decodeMessage = Schema.decodeSync(MessageJson)
const EnvironmentJson = Schema.toCodecJson(AgentExecutor.ExecutionEnvironment)

const waitForSwap = (session: string) =>
  Effect.suspend(() => {
    if (!Plugins.isSwapping()) return Effect.void
    const started = Date.now()
    log("turn.waitingForSwap", { session })
    return Effect.map(Plugins.awaitNoSwap, () => log("turn.waitedForSwap", { session, ms: Date.now() - started }))
  })

// --- one session's clanka -----------------------------------------------------

const makeBrain = (row: { id: string; thread: string; environment: string | null }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const directory = join(WORK, row.id)
    mkdirSync(directory, { recursive: true })
    // One executor per session, kept across rebuilds.
    const executor = yield* Layer.build(AgentExecutor.layerLocal({ directory }))

    let agent: Agent.Agent | undefined
    let agentScope: Scope.Closeable | undefined
    let generation = -1
    // TIM-555: what the Agent's MCP section and declarations were built against.
    let mcpBuilt = ""
    let built = new Map<string, string>()
    let rebuilds = 0

    /** Build this session's Agent on the plugin versions that are current now. */
    const rebuild = Effect.gen(function*() {
      const versions = [...Plugins.slots.values()].flatMap((s) => s.current ? [s.current] : [])
      const handlers: Record<string, (params: any) => Effect.Effect<any, any>> = {
        mark: ({ label }: { label: string }) => Effect.sync(() => (log("script.mark", { session: row.id, label }), "marked")),
        pause: ({ ms }: { ms: number }) => Effect.as(Effect.sleep(ms), "paused"),
        hold: ({ label }: { label: string }) => Effect.as(Deferred.await(latch(label)), "released")
      }
      const nextBuilt = new Map<string, string>()
      const declarations: Record<string, string> = {}
      for (const version of versions) {
        nextBuilt.set(version.plugin, version.hash)
        for (const [tool, entry] of version.tools) {
          handlers[tool] = Plugins.wrapper(row.id, version.plugin, tool, { hash: version.hash, decl: entry.decl, instance: version.instance, tool: entry.tool })
          declarations[tool] = entry.decl
        }
      }
      const toolkit: any = Toolkit.merge(CoreTools, ...versions.flatMap((v) => v.toolkits))
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(toolkit.toLayer(handlers) as Layer.Layer<any>, scope)
      const next: Agent.Agent = yield* (Agent.makeWith({ loopTools: toolkit, skills: [], instructions: Option.none() }) as any).pipe(
        Effect.provideContext(context),
        Effect.provideContext(executor),
        // TIM-555: every Agent is handed chad's wrapper, never clanka's own layer.
        Effect.provideService(McpServers.McpServers, Mcp.serviceFor(row.id)),
        Scope.provide(scope)
      )
      if (agent !== undefined) {
        MutableRef.set(next.history, agent.history.current)
        MutableRef.set(next.environment, agent.environment.current)
        // The old Agent's scope closes at a turn boundary, where it has nothing running.
        yield* Scope.close(agentScope!, Exit.void)
      } else {
        const stored = yield* Effect.orDie(sql<{ message: string }>`SELECT message FROM session_messages WHERE session = ${row.id} ORDER BY seq`)
        if (stored.length > 0) {
          MutableRef.set(next.history, Prompt.fromMessages(stored.map((r) => decodeMessage(JSON.parse(r.message)))))
          if (row.environment !== null) MutableRef.set(next.environment, Schema.decodeSync(EnvironmentJson)(JSON.parse(row.environment)))
          log("session.restored", { session: row.id, messages: stored.length })
        }
      }
      agent = next
      agentScope = scope
      generation = Plugins.generation
      mcpBuilt = Mcp.builtToken()
      built = nextBuilt
      log("agent.built", { session: row.id, rebuild: rebuilds++, generation, mcp: mcpBuilt, mcpPrompt: Mcp.promptHash(), on: Object.fromEntries(nextBuilt), tools: Object.keys(declarations) })
    })
    yield* Effect.addFinalizer(() => agentScope ? Scope.close(agentScope, Exit.void) : Effect.void)

    return {
      steer: (text: string) => agent ? agent.steer(text) : Effect.never,
      runTurn: (prompts: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          // A swap that began after the beforeTurn hooks: the Agent is still built on what is active afterwards.
          yield* waitForSwap(row.id)
          // TIM-555, rule 6: a turn that starts during an MCP rebuild waits for the new layer, up to a cap.
          yield* Mcp.awaitTurnStart(row.id)
          if (agent === undefined || generation !== Plugins.generation || mcpBuilt !== Mcp.builtToken()) yield* rebuild
          const running = { built, subagents: 0 }
          Plugins.runningTurns.set(row.id, running)
          const stream = yield* agent!.send({
            prompt: prompts.map((content) => ({ role: "user" as const, content })),
            system: (options) => {
              const starting = Mcp.startedWithout(row.id)
              const system = "You are chad.\n\n" + options.toolInstructions + (starting ? "\n\n" + Mcp.STILL_STARTING : "")
              log("turn.system", { session: row.id, hasMcpSection: system.includes("# MCP servers"), saysStillStarting: starting, mentions: [...system.matchAll(/^- (\w+)(?: \(| ?:)/gm)].map((x) => x[1]) })
              return system
            }
          })
          const answer = yield* stream.pipe(
            Stream.runForEach((part: any) =>
              Effect.gen(function*() {
                switch (part._tag) {
                  case "HistoryAppended":
                    for (const message of part.messages) {
                      yield* sql`INSERT INTO session_messages (session, message) VALUES (${row.id}, ${JSON.stringify(encodeMessage(message))})`
                    }
                    break
                  case "SubagentStart":
                    running.subagents++
                    log("brain.subagentStart", { session: row.id })
                    break
                  case "SubagentComplete":
                    running.subagents--
                    log("brain.subagentComplete", { session: row.id })
                    break
                  case "ScriptOutput":
                    log("brain.scriptOutput", { session: row.id, output: String(part.output).slice(0, 600) })
                    break
                }
              }).pipe(Effect.orDie)
            ),
            Effect.as("(the stream ended without an answer)"),
            Effect.catchTag("AgentFinished", (finished: any) => Effect.succeed(String(finished.summary)))
          )
          yield* Effect.orDie(sql`UPDATE sessions SET environment = ${JSON.stringify(Schema.encodeSync(EnvironmentJson)(agent!.environment.current))} WHERE thread = ${row.thread}`)
          return answer as string
        }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => {
          Plugins.runningTurns.delete(row.id)
          Mcp.turnEnded(row.id)
        })))
    }
  })

// --- the Session entity -----------------------------------------------------

interface Run {
  readonly done: Deferred.Deferred<"ended" | "stopped">
  fiber: Fiber.Fiber<any, any> | undefined
  stopped: boolean
}

export const SessionLive = Session.toLayer(
  Effect.gen(function*() {
    const address = yield* Entity.CurrentAddress
    const threadId = address.entityId as string
    const sql = yield* SqlClient.SqlClient
    const chat = yield* Chat.Chat

    yield* sql`INSERT OR IGNORE INTO sessions (thread, id) VALUES (${threadId}, ${'s-' + threadId})`.pipe(Effect.orDie)
    const [row] = yield* Effect.orDie(sql<{ id: string; thread: string; environment: string | null }>`SELECT * FROM sessions WHERE thread = ${threadId}`)
    const brain = yield* makeBrain(row)
    log("session.activated", { thread: threadId, session: row.id })

    const state = { running: undefined as Run | undefined }
    const say = (markdown: string) => Effect.orDie(chat.post(thread(threadId), { markdown }))

    interface Request {
      readonly key: string
      readonly origin: unknown
      readonly prompt: string
    }

    const runTurn = (request: Request, run: Run) =>
      Effect.gen(function*() {
        yield* sql`INSERT OR IGNORE INTO turns (key, id, thread, origin) VALUES (${request.key}, ${randomUUID()}, ${threadId}, ${JSON.stringify(request.origin)})`
        yield* sql`UPDATE turns SET starts = starts + 1, state = 'running' WHERE key = ${request.key}`
        const [t] = yield* sql<{ id: string; starts: number; cuts: number }>`SELECT id, starts, cuts FROM turns WHERE key = ${request.key}`
        const kills = t.starts - 1 - t.cuts
        const resumed = t.starts >= 2
        log("turn.start", { key: request.key, session: row.id, turn: t.id, starts: t.starts, cuts: t.cuts, resumed })

        const finish = (outcome: Outcome) =>
          Effect.gen(function*() {
            yield* sql`UPDATE turns SET state = 'ended', outcome = ${outcome._tag} WHERE key = ${request.key}`
            log("turn.end", { key: request.key, session: row.id, turn: t.id, outcome: outcome._tag, text: (outcome as any).text })
            // Off the reply path, queued under the plugin's name.
            const payload = { session: row.id, turn: t.id, outcome: outcome._tag }
            for (const slot of Plugins.slots.values()) {
              if (slot.current?.hooks.has("afterTurn")) Plugins.enqueueHook(slot.name, "afterTurn", payload)
            }
            // The scripted model does not compact. A prompt that says so stands in for a turn that did.
            if (/\bCOMPACTED\b/.test(request.prompt)) {
              for (const slot of Plugins.slots.values()) {
                if (slot.current?.hooks.has("Compacted")) Plugins.enqueueHook(slot.name, "Compacted", payload)
              }
            }
            return outcome
          })

        if (kills >= 2) {
          yield* say("-# The last turn was cut off twice by a restart, so I stopped.")
          return yield* finish({ _tag: "Failed", reason: "Interrupted" })
        }

        const prompts: Array<string> = []
        // A turn that starts during a swap waits for the activation, so its beforeTurn hooks run on the new versions.
        yield* waitForSwap(row.id)
        for (const slot of [...Plugins.slots.values()].sort((a, b) => a.name.localeCompare(b.name))) {
          const text = yield* Plugins.runHook(slot.name, "beforeTurn", { session: row.id, turn: t.id })
          if (Option.isSome(text) && typeof text.value === "string") prompts.push("<plugin-context plugin=\"" + slot.name + "\">\n" + text.value + "\n</plugin-context>")
        }
        prompts.push(resumed ? RESTART_NOTE : request.prompt)

        const fiber = yield* Effect.forkChild(brain.runTurn(prompts))
        run.fiber = fiber
        const exit = yield* Fiber.await(fiber)
        run.fiber = undefined

        if (Exit.isSuccess(exit)) {
          yield* say(exit.value)
          return yield* finish({ _tag: "Answered", text: exit.value })
        }
        if (run.stopped) {
          yield* say("-# stopped")
          return yield* finish({ _tag: "Stopped" })
        }
        if (Exit.hasInterrupts(exit)) return yield* Effect.interrupt
        log("turn.brainFailed", { key: request.key, cause: String(exit.cause).slice(0, 600) })
        yield* say("-# That turn failed.")
        return yield* finish({ _tag: "Failed", reason: "ModelError" })
      }).pipe(
        Effect.onInterrupt(() =>
          sql`UPDATE turns SET cuts = cuts + 1 WHERE key = ${request.key} AND state = 'running'`.pipe(
            Effect.exit,
            Effect.map((exit) => log("turn.cutByShutdown", { key: request.key, saved: Exit.isSuccess(exit) }))
          )
        ),
        Effect.orDie,
        Effect.ensuring(Effect.sync(() => {
          state.running = undefined
          Deferred.doneUnsafe(run.done, Exit.succeed(run.stopped ? "stopped" as const : "ended" as const))
        }))
      )

    const take = (): Run => (state.running = { done: Deferred.makeUnsafe(), fiber: undefined, stopped: false })
    const stored = (tag: string | null): Outcome =>
      tag === "Answered" ? { _tag: "Answered", text: "" } : tag === "Stopped" ? { _tag: "Stopped" } : { _tag: "Failed", reason: "unknown" }

    return {
      message: (envelope) =>
        Effect.gen(function*() {
          const p = envelope.payload
          log("message.delivered", { key: p.key, session: row.id })
          const prior = yield* Effect.orDie(sql<{ state: string; outcome: string | null }>`SELECT state, outcome FROM turns WHERE key = ${p.key}`)
          if (prior[0]?.state === "steered") return { _tag: "Steered" } as Outcome
          if (prior[0]?.state === "ended") return stored(prior[0].outcome)
          while (true) {
            const current = state.running
            if (current === undefined) {
              return yield* runTurn({ key: p.key, origin: { _tag: "Message", text: p.text }, prompt: p.text }, take())
            }
            const result = yield* Effect.raceFirst(Effect.as(brain.steer(p.text), "steered" as const), Deferred.await(current.done))
            if (result === "steered") {
              yield* Effect.orDie(sql`INSERT OR REPLACE INTO turns (key, id, thread, origin, state) VALUES (${p.key}, ${randomUUID()}, ${threadId}, '{}', 'steered')`)
              log("message.steered", { key: p.key })
              return { _tag: "Steered" } as Outcome
            }
            if (result === "stopped") return { _tag: "Dropped" } as Outcome
          }
        }),
      pluginTurn: (envelope) =>
        Effect.gen(function*() {
          const p = envelope.payload
          log("pluginTurn.delivered", { key: p.key, session: row.id })
          const prior = yield* Effect.orDie(sql<{ state: string; outcome: string | null }>`SELECT state, outcome FROM turns WHERE key = ${p.key}`)
          if (prior[0]?.state === "ended") return stored(prior[0].outcome)
          while (state.running !== undefined) yield* Deferred.await(state.running.done)
          return yield* runTurn({ key: p.key, origin: { _tag: "Plugin", plugin: p.plugin, label: p.label }, prompt: p.prompt }, take())
        }),
      stop: (envelope) =>
        Effect.gen(function*() {
          const run = state.running
          log("stop.received", { by: envelope.payload.by, running: run !== undefined })
          if (run === undefined || run.fiber === undefined) return { stopped: false }
          run.stopped = true
          Effect.runFork(Fiber.interrupt(run.fiber))
          return { stopped: true }
        })
    }
  }),
  { concurrency: "unbounded", maxIdleTime: 30 * 60_000, disableFatalDefects: true }
)

// --- the Timer entity: one address per plugin timer -------------------------

const timerId = (plugin: string, name: string) => plugin + "/" + name

export const TimerLive = Timer.toLayer(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const makeSession = yield* Session.client
    const read = (plugin: string, name: string) =>
      Effect.map(
        Effect.orDie(sql<{ thread: string; prompt: string; next_run: number }>`SELECT * FROM timers WHERE plugin = ${plugin} AND name = ${name}`),
        (rows) => rows[0]
      )
    return {
      fire: (envelope) =>
        Effect.gen(function*() {
          const { plugin, name, at } = envelope.payload
          log("timer.delivered", { timer: timerId(plugin, name), at, lateMs: Date.now() - at })
          // The handler is core code. The drain neither waits for it nor interrupts it. Only the gate applies.
          const started = Date.now()
          const held = yield* Plugins.awaitUsable(plugin)
          if (held !== "ready") log("timer.held", { timer: timerId(plugin, name), why: held, ms: Date.now() - started })
          const row = yield* read(plugin, name)
          if (row === undefined || row.next_run !== at) return void log("timer.stale", { timer: timerId(plugin, name), at })
          const outcome = yield* makeSession(row.thread).pluginTurn(
            new PluginTurn({ key: "timer/" + plugin + "/" + name + "/" + at, thread: row.thread, prompt: row.prompt, plugin, label: name, sentAt: Date.now() })
          ).pipe(Effect.orDie)
          log("timer.turnEnded", { timer: timerId(plugin, name), at, outcome: outcome._tag })
          yield* Effect.orDie(sql`DELETE FROM timers WHERE plugin = ${plugin} AND name = ${name}`)
        })
    }
  }),
  { disableFatalDefects: true }
)

export const Turns = {
  schedule: (options: { plugin: string; name: string; thread: string; prompt: string; at: number }) =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const makeTimer = yield* Timer.client
      const sharding = yield* Sharding.Sharding
      const storage = yield* MessageStorage.MessageStorage
      yield* sql`INSERT OR REPLACE INTO timers (plugin, name, thread, prompt, next_run) VALUES (${options.plugin}, ${options.name}, ${options.thread}, ${options.prompt}, ${options.at})`
      const entityId = timerId(options.plugin, options.name) as any
      yield* storage.clearAddress(new EntityAddress({ entityType: Timer.type, entityId, shardId: sharding.getShardId(entityId, Timer.getShardGroup(entityId)) }))
      yield* makeTimer(entityId).fire(new Fire({ plugin: options.plugin, name: options.name, at: options.at }), { discard: true })
      log("turns.scheduled", { timer: entityId, at: options.at })
    })
}

// --- the gateway handler ----------------------------------------------------

const GatewayLive = ChatHandler.layer((event) =>
  Effect.gen(function*() {
    if (event._tag !== "MessageCreated") return
    if (event.message.author.id !== OWNER) return
    const makeSession = yield* Session.client
    const text = event.message.text.trim()
    if (text === "/stop") {
      yield* makeSession(event.thread.id).stop({ by: "command" }).pipe(Effect.orDie)
      return
    }
    const key = ChatEvent.dedupeKey(event)
    yield* makeSession(event.thread.id).message(
      new Incoming({ key, thread: event.thread.id, text, userId: event.message.author.id, sentAt: Date.now() }),
      { discard: true }
    ).pipe(Effect.mapError(() => new ChatHandler.NotAccepted()))
  })
)

// --- assembly. Later lines are built first and closed last. -----------------

/** Plugins load at boot and close last of the three: after the entities stop, after the queued hooks ran. */
const PluginsLive = Layer.effectDiscard(Effect.gen(function*() {
  yield* Plugins.boot
  yield* Effect.addFinalizer(() => Plugins.closeAll)
  // TIM-555: the MCP layer connects at boot and closes in the ordinary graceful stop.
  yield* Mcp.boot
  yield* Effect.addFinalizer(() => Mcp.closeAll)
}))
const HooksLive = Layer.effectDiscard(Effect.addFinalizer(() => Plugins.drainHooks))
/** Built last, so closed first: a graceful stop abandons a swap before anything waits on requests in flight. */
const AbandonLive = Layer.effectDiscard(Effect.addFinalizer(() => Plugins.abandon))

/** Only log lines, to see where a graceful stop spends its time. */
const marker = (ev: string) => Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => log(ev))))

export const HostLive = AbandonLive.pipe(
  Layer.provideMerge(Layer.mergeAll(SessionLive, TimerLive, GatewayLive)),
  Layer.provideMerge(marker("stop.entityLayersClosed")),
  Layer.provideMerge(SingleRunner.layer({ shardingConfig: { entityMessagePollInterval: 1000 } })),
  Layer.provideMerge(marker("stop.runnerClosed")),
  Layer.provideMerge(HooksLive),
  Layer.provideMerge(PluginsLive),
  Layer.provideMerge(ChatTest.layer()),
  Layer.provideMerge(TablesLive),
  Layer.provideMerge(Layer.mergeAll(ScriptedModel, Agent.ConversationMode.layer(true))),
  Layer.provideMerge(Layer.mergeAll(SqliteClient.layer({ filename: DB }), NodeCrypto.layerDigest, NodeServices.layer, NodeHttpClient.layerUndici))
)
