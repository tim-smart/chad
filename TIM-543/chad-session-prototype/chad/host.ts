// PROTOTYPE for "The Session entity run on SingleRunner and SQLite" (TIM-543).
// Throwaway. A stand-in for chad's core: a Session entity and a Timer entity on
// effect cluster's SingleRunner over one SQLite file, ChatTest in place of
// Discord, clanka through openai-compat (or a scripted fake brain where the
// check is about cluster and not about the model).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Agent, AgentExecutor } from "clanka"
import * as Compaction from "clanka/Compaction"
import * as OpenAiCompat from "clanka/OpenAiCompat"
import * as Prompt from "effect/ai/Prompt"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Chat from "effect/chat/Chat"
import * as ChatEvent from "effect/chat/ChatEvent"
import * as ChatHandler from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as ChatTest from "effect/chat/ChatTest"
import * as ChatThread from "effect/chat/ChatThread"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as DeliverAt from "effect/cluster/DeliverAt"
import * as Entity from "effect/cluster/Entity"
import { EntityAddress } from "effect/cluster/EntityAddress"
import * as MessageRetention from "effect/cluster/MessageRetention"
import * as MessageStorage from "effect/cluster/MessageStorage"
import * as Sharding from "effect/cluster/Sharding"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as Context from "effect/Context"
import * as Cron from "effect/Cron"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as PrimaryKey from "effect/PrimaryKey"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Rpc from "effect/rpc/Rpc"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

// --- knobs, all from env so the driver can vary them per scenario -----------

const env = process.env
export const DB = env.PROTO_DB ?? "PROTOTYPE-wipe-me.sqlite"
export const LOG = env.PROTO_LOG ?? "events.jsonl"
export const WORK = env.PROTO_WORK ?? "work"
export const BRAIN = (env.PROTO_BRAIN ?? "fake") as "fake" | "real"
const IDLE_MS = Number(env.PROTO_IDLE ?? 30 * 60_000)
const BUDGET = {
  chunk: Number(env.PROTO_BUDGET_CHUNK ?? 2_000),
  beforeTurn: Number(env.PROTO_BUDGET_BEFORE ?? 5_000),
  afterTurn: Number(env.PROTO_BUDGET_AFTER ?? 30_000),
  onSession: Number(env.PROTO_BUDGET_SESSION ?? 10_000)
}
const RETENTION_MS = env.PROTO_RETENTION ? Number(env.PROTO_RETENTION) : undefined
const GRACEFUL_FREE = env.PROTO_GRACEFUL_FREE === "1"
export const OWNER = "owner-1"
const PLATFORM = "test"

/** Every observable step goes to one JSON-lines file, written synchronously so a kill cannot lose it. */
export const log = (ev: string, data: Record<string, unknown> = {}) =>
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ev, ...data }) + "\n")

// --- stand-in plugins. A scenario fills this before the host starts. --------

export interface Turn {
  readonly id: string
  readonly session: string
  readonly origin: unknown
  readonly resumed: boolean
  readonly prompt: string
}
export interface StubPlugin {
  readonly name: string
  readonly chunk?: () => Effect.Effect<string, unknown>
  readonly beforeTurn?: (turn: Turn) => Effect.Effect<string | void, unknown>
  readonly afterTurn?: (turn: Turn, outcome: any) => Effect.Effect<void, unknown>
  readonly onSession?: (event: { readonly _tag: "Compacted"; readonly session: string }) => Effect.Effect<void, unknown>
}
export const registry = {
  plugins: [] as Array<StubPlugin>,
  /** Plugins that exist but are not loaded (safe mode, a failed build). */
  unloaded: new Set<string>(),
  waiters: [] as Array<{ plugin: string; resume: () => void }>,
  load(plugin: string) {
    this.unloaded.delete(plugin)
    log("plugin.loaded", { plugin })
    for (const w of this.waiters.splice(0)) w.plugin === plugin ? w.resume() : this.waiters.push(w)
  },
  awaitLoaded(plugin: string): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      if (!this.unloaded.has(plugin)) return resume(Effect.void)
      const w = { plugin, resume: () => resume(Effect.void) }
      this.waiters.push(w)
      return Effect.sync(() => void this.waiters.splice(this.waiters.indexOf(w), 1))
    })
  }
}

const PluginsLive = Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => log("plugins.closed"))))

// --- hooks that run off the reply path: one at a time per plugin, in order --

interface Job {
  readonly plugin: string
  readonly label: string
  readonly effect: Effect.Effect<void, unknown>
  readonly budget: number
  readonly done: Deferred.Deferred<void>
}
export class Hooks extends Context.Service<Hooks, {
  readonly enqueue: (plugin: string, label: string, effect: Effect.Effect<void, unknown>, budget: number) => Deferred.Deferred<void>
}>()("proto/Hooks") {}

const HooksLive = Layer.effect(
  Hooks,
  Effect.gen(function*() {
    const queues = new Map<string, Queue.Queue<Job>>()
    const workers: Array<Fiber.Fiber<unknown, unknown>> = []
    let pending = 0
    const run = (job: Job) =>
      Effect.gen(function*() {
        const started = Date.now()
        const exit = yield* job.effect.pipe(Effect.timeoutOption(job.budget), Effect.exit)
        const result = Exit.isFailure(exit) ? "failed" : Option.isNone(exit.value) ? "timeout" : "ok"
        log("hook.done", { plugin: job.plugin, label: job.label, result, ms: Date.now() - started })
        pending--
        Deferred.doneUnsafe(job.done, Exit.void)
      })
    // A graceful stop runs what is queued, each inside its budget, before the
    // plugins' scopes close. Workers are detached so closing this scope does
    // not interrupt them before the drain.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        log("hooks.draining", { pending })
        while (pending > 0) yield* Effect.sleep(20)
        log("hooks.drained")
        yield* Fiber.interruptAll(workers)
      })
    )
    return Hooks.of({
      enqueue: (plugin, label, effect, budget) => {
        const job: Job = { plugin, label, effect, budget, done: Deferred.makeUnsafe<void>() }
        let queue = queues.get(plugin)
        if (queue === undefined) {
          queue = Effect.runSync(Queue.unbounded<Job>())
          queues.set(plugin, queue)
          const q = queue
          workers.push(Effect.runFork(Effect.forever(Effect.flatMap(Queue.take(q), run))))
        }
        pending++
        Queue.offerUnsafe(queue, job)
        return job.done
      }
    })
  })
).pipe(Layer.provide(PluginsLive))

// --- the SQLite tables chad owns, next to cluster's own ---------------------

const TablesLive = Layer.effectDiscard(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS sessions (thread TEXT PRIMARY KEY, id TEXT NOT NULL, environment TEXT, system TEXT, chunks TEXT NOT NULL DEFAULT '{}')`
  yield* sql`CREATE TABLE IF NOT EXISTS session_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, message TEXT NOT NULL)`
  // One row per turn request. starts counts how often chad began it, which is how a redelivery is told from a first delivery.
  yield* sql`CREATE TABLE IF NOT EXISTS turns (key TEXT PRIMARY KEY, id TEXT NOT NULL, thread TEXT NOT NULL, origin TEXT NOT NULL, starts INTEGER NOT NULL DEFAULT 0, cuts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new', outcome TEXT)`
  yield* sql`CREATE TABLE IF NOT EXISTS timers (plugin TEXT NOT NULL, name TEXT NOT NULL, thread TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, every_ms INTEGER, next_run INTEGER NOT NULL, PRIMARY KEY (plugin, name))`
}).pipe(Effect.orDie))

// --- protocol ---------------------------------------------------------------

export const Outcome = Schema.Union([
  Schema.TaggedStruct("Answered", { text: Schema.String }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  Schema.TaggedStruct("Stopped", {}),
  // The two replies only an owner message can get: it joined a running turn, or the turn it was steering was stopped.
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
  timer: Schema.optionalKey(Schema.Struct({ name: Schema.String, scheduledAt: Schema.Number })),
  mention: Schema.optionalKey(Schema.String),
  sentAt: Schema.Number
}) {
  [PrimaryKey.symbol]() {
    return this.key
  }
}

export const Session = Entity.make("Session", [
  Rpc.make("message", { payload: Incoming, success: Outcome }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("pluginTurn", { payload: PluginTurn, success: Outcome }).annotate(ClusterSchema.Persisted, true),
  // Not persisted: a stop that is lost in a crash has nothing left to stop.
  Rpc.make("stop", { payload: Schema.Struct({ by: Schema.String }), success: Schema.Struct({ stopped: Schema.Boolean }) }),
  // Test helper standing in for "a background task is running".
  Rpc.make("hold", { payload: Schema.Struct({ ms: Schema.Number }) }),
  Rpc.make("peek", { success: Schema.Struct({ activation: Schema.Number, sends: Schema.Number, maxActiveSends: Schema.Number, system: Schema.String }) })
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

export const StopButton = ChatInteraction.button("stop", { label: "Stop", style: "danger" })
const Buttons = ChatInteraction.group(StopButton)

const thread = (id: string) => ChatThread.make(PLATFORM, id)
const RESTART_NOTE =
  "[chad restarted while this turn was running. A script that was cut off may already have had its side effects. Check before you repeat anything, then finish the request above.]"

// --- brains -----------------------------------------------------------------

interface Brain {
  readonly runTurn: (prompts: ReadonlyArray<string>) => Effect.Effect<{ answer: string; compacted: boolean; usage: Array<string> }, unknown, any>
  readonly steer: (text: string) => Effect.Effect<void>
  readonly stats: () => { sends: number; maxActiveSends: number; system: string }
}

/** A scripted turn: "sleep:<ms>" sets how long it takes, "compact" marks it as having compacted. */
const makeFakeBrain = (sessionId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const mailbox: Array<{ text: string; resume: () => void }> = []
    const append = (role: string, text: string) =>
      Effect.orDie(sql`INSERT INTO session_messages (session, message) VALUES (${sessionId}, ${JSON.stringify({ role, text })})`)
    let sends = 0, active = 0, maxActive = 0
    const brain: Brain = {
      stats: () => ({ sends, maxActiveSends: maxActive, system: "" }),
      steer: (text) =>
        Effect.callback<void>((resume) => {
          const entry = { text, resume: () => resume(Effect.void) }
          mailbox.push(entry)
          return Effect.sync(() => {
            const i = mailbox.indexOf(entry)
            if (i >= 0) mailbox.splice(i, 1)
          })
        }),
      runTurn: (prompts) =>
        Effect.gen(function*() {
          sends++
          maxActive = Math.max(maxActive, ++active)
          for (const p of prompts) yield* append("user", p)
          let last = prompts[prompts.length - 1]
          if (last.startsWith("[chad restarted")) {
            // A resumed turn carries on with the request that was cut off, which is the last one in the stored history.
            const rows = yield* Effect.orDie(sql<{ message: string }>`SELECT message FROM session_messages WHERE session = ${sessionId} AND message LIKE '%sleep:%' ORDER BY seq DESC LIMIT 1`)
            if (rows[0]) last = JSON.parse(rows[0].message).text
          }
          let ms = Number(/sleep:(\d+)/.exec(last)?.[1] ?? 200)
          let waited = 0
          while (true) {
            while (mailbox.length > 0) {
              const entry = mailbox.shift()!
              yield* append("user", entry.text)
              entry.resume()
              ms += Number(/sleep:(\d+)/.exec(entry.text)?.[1] ?? 0)
            }
            if (waited >= ms) break
            yield* Effect.sleep(25)
            waited += 25
          }
          const answer = /\[SILENT\]/.test(last) ? "[SILENT]" : "done: " + last.slice(0, 80)
          yield* append("assistant", answer)
          return { answer, compacted: /compact/.test(last), usage: [] }
        }).pipe(Effect.ensuring(Effect.sync(() => void active--)))
    }
    return brain
  })

const MessageJson = Schema.toCodecJson(Prompt.Message)
const encodeMessage = Schema.encodeSync(MessageJson)
const decodeMessage = Schema.decodeSync(MessageJson)
const EnvironmentJson = Schema.toCodecJson(AgentExecutor.ExecutionEnvironment)

/** The one loop-side tool: what cron's cronRun would do. */
const PluginTools = Toolkit.make(
  Tool.make("queueTurn", {
    description: "Queue a follow-up turn in this same thread. Returns at once; the turn runs after the current one ends.",
    parameters: Schema.Struct({ prompt: Schema.String }),
    success: Schema.Struct({ status: Schema.String })
  })
)

const makeRealBrain = (row: { id: string; thread: string; environment: string | null; system: string | null }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const makeClient = yield* Session.client
    const directory = join(WORK, row.id)
    mkdirSync(directory, { recursive: true })
    const executor = yield* Layer.build(AgentExecutor.layerLocal({ directory }))
    const tools = yield* Layer.build(PluginTools.toLayer({
      queueTurn: ({ prompt }) =>
        Effect.gen(function*() {
          const started = Date.now()
          // discard: true returns once the request is saved. Waiting for the outcome here would deadlock, because the queued turn runs behind this one.
          yield* makeClient(row.thread).pluginTurn(
            new PluginTurn({ key: "start/" + randomUUID(), thread: row.thread, prompt, plugin: "cron", label: "queueTurn", sentAt: started }),
            { discard: true }
          ).pipe(Effect.orDie)
          log("tool.queueTurn.returned", { ms: Date.now() - started })
          return { status: "queued" }
        })
    }))
    const agent: Agent.Agent = yield* (Agent.makeWith({ loopTools: PluginTools as any, skills: [], instructions: Option.none() }) as any).pipe(
      Effect.provideContext(tools),
      Effect.provideContext(executor)
    )
    // Restore. The stored rows are what clanka appended, in order.
    const stored = yield* Effect.orDie(sql<{ message: string }>`SELECT message FROM session_messages WHERE session = ${row.id} ORDER BY seq`)
    if (stored.length > 0) {
      MutableRef.set(agent.history, Prompt.fromMessages(stored.map((r) => decodeMessage(JSON.parse(r.message)))))
      if (row.environment !== null) {
        MutableRef.set(agent.environment, Schema.decodeSync(EnvironmentJson)(JSON.parse(row.environment)))
      }
      log("session.restored", { messages: stored.length, frozenSystem: row.system !== null })
    }
    let frozen = row.system ?? undefined
    let sends = 0, active = 0, maxActive = 0
    const brain: Brain = {
      stats: () => ({ sends, maxActiveSends: maxActive, system: frozen ?? "" }),
      steer: (text) => agent.steer(text),
      runTurn: (prompts) =>
        Effect.gen(function*() {
          sends++
          maxActive = Math.max(maxActive, ++active)
          let compacted = false
          let last = { inputTokens: 0, cacheRead: 0 }
          const usage: Array<string> = []
          const stream = yield* agent.send({
            prompt: prompts.map((content) => ({ role: "user" as const, content })),
            // The session's system prompt is rendered once and then frozen, so a restored session sends the same bytes.
            system: (options) => {
              if (frozen === undefined) {
                frozen = "You are chad, Tim's personal assistant. Answer in one short sentence.\n\n" + options.toolInstructions
                Effect.runFork(sql`UPDATE sessions SET system = ${frozen} WHERE thread = ${row.thread}`)
              }
              return frozen
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
                  case "HistoryReplaced":
                    yield* sql.withTransaction(Effect.gen(function*() {
                      yield* sql`DELETE FROM session_messages WHERE session = ${row.id}`
                      for (const message of part.messages) {
                        yield* sql`INSERT INTO session_messages (session, message) VALUES (${row.id}, ${JSON.stringify(encodeMessage(message))})`
                      }
                    }))
                    compacted = true
                    log("brain.historyReplaced", { messages: part.messages.length })
                    break
                  case "Usage":
                    usage.push((part.inputTokens - last.inputTokens) + " in / " + (part.cacheRead - last.cacheRead) + " cached")
                    last = part
                    break
                  case "CompactionStarted":
                  case "CompactionEnded":
                    log("brain." + part._tag, { reason: part.reason, tokensBefore: part.tokensBefore, tokensAfter: part.tokensAfter })
                    break
                  case "ScriptEnd":
                    log("brain.scriptEnd")
                    break
                  case "ScriptOutput":
                    log("brain.scriptOutput", { output: String(part.output).slice(0, 200) })
                    break
                }
              }).pipe(Effect.orDie)
            ),
            Effect.as("(the stream ended without an answer)"),
            Effect.catchTag("AgentFinished", (finished: any) => Effect.succeed(String(finished.summary)))
          )
          yield* Effect.orDie(sql`UPDATE sessions SET environment = ${JSON.stringify(Schema.encodeSync(EnvironmentJson)(agent.environment.current))} WHERE thread = ${row.thread}`)
          return { answer, compacted, usage }
        }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => void active--)))
    }
    return brain
  })

// --- the Session entity -----------------------------------------------------

interface Run {
  readonly done: Deferred.Deferred<"ended" | "stopped">
  fiber: Fiber.Fiber<any, any> | undefined
  stopped: boolean
}
let activations = 0

export const SessionLive = Session.toLayer(
  Effect.gen(function*() {
    const address = yield* Entity.CurrentAddress
    const threadId = address.entityId as string
    const activationScope = yield* Effect.scope
    const sql = yield* SqlClient.SqlClient
    const chat = yield* Chat.Chat
    const hooks = yield* Hooks
    const activation = ++activations

    yield* sql`INSERT OR IGNORE INTO sessions (thread, id) VALUES (${threadId}, ${randomUUID()})`.pipe(Effect.orDie)
    const [row] = yield* Effect.orDie(
      sql<{ id: string; thread: string; environment: string | null; system: string | null; chunks: string }>`SELECT * FROM sessions WHERE thread = ${threadId}`
    )
    const seen: Record<string, string> = JSON.parse(row.chunks)
    const brain = BRAIN === "real" ? yield* makeRealBrain(row) : yield* makeFakeBrain(row.id)
    log("session.activated", { thread: threadId, session: row.id, activation })
    yield* Effect.addFinalizer(() => Effect.sync(() => log("session.passivated", { thread: threadId, activation })))

    const state = { running: undefined as Run | undefined, gate: undefined as Deferred.Deferred<void> | undefined }
    const say = (markdown: string) => Effect.orDie(chat.post(thread(threadId), { markdown }))

    interface Request {
      readonly key: string
      readonly origin: unknown
      readonly prompt: string
      readonly plugin: boolean
      readonly mention?: string | undefined
    }

    /** The caller has already taken the turn slot by setting state.running, with no yield in between. */
    const runTurn = (request: Request, run: Run) =>
      Effect.gen(function*() {
        // Count this start. The origin and id of the first attempt are kept, so a resumed turn reports them.
        yield* sql`INSERT OR IGNORE INTO turns (key, id, thread, origin) VALUES (${request.key}, ${randomUUID()}, ${threadId}, ${JSON.stringify(request.origin)})`
        yield* sql`UPDATE turns SET starts = starts + 1, state = 'running' WHERE key = ${request.key}`
        const [t] = yield* sql<{ id: string; origin: string; starts: number; cuts: number }>`SELECT id, origin, starts, cuts FROM turns WHERE key = ${request.key}`
        // Starts that ended in a kill. A start cut by a graceful stop is recorded in cuts and is not counted (PROTO_GRACEFUL_FREE).
        const kills = t.starts - 1 - (GRACEFUL_FREE ? t.cuts : 0)
        const resumed = t.starts >= 2
        const turn: Turn = { id: t.id, session: row.id, origin: JSON.parse(t.origin), resumed, prompt: t.starts >= 2 ? RESTART_NOTE : request.prompt }
        log("turn.start", { key: request.key, turn: turn.id, starts: t.starts, cuts: t.cuts, kills, resumed })

        const finish = (outcome: Outcome, compacted: boolean) =>
          Effect.gen(function*() {
            yield* sql`UPDATE turns SET state = 'ended', outcome = ${outcome._tag} WHERE key = ${request.key}`
            log("turn.end", { key: request.key, turn: turn.id, outcome: outcome._tag, compacted })
            // Off the reply path. After a turn that compacted, the next turn waits for these.
            const jobs: Array<Deferred.Deferred<void>> = []
            for (const p of registry.plugins) {
              if (p.afterTurn && !registry.unloaded.has(p.name)) jobs.push(hooks.enqueue(p.name, "afterTurn", p.afterTurn(turn, outcome), BUDGET.afterTurn))
            }
            if (compacted) {
              for (const p of registry.plugins) {
                if (p.onSession && !registry.unloaded.has(p.name)) {
                  jobs.push(hooks.enqueue(p.name, "Compacted", p.onSession({ _tag: "Compacted", session: row.id }), BUDGET.onSession))
                }
              }
              const gate = Deferred.makeUnsafe<void>()
              state.gate = gate
              Effect.runFork(Effect.forEach(jobs, (d) => Deferred.await(d)).pipe(Effect.andThen(Effect.sync(() => Deferred.doneUnsafe(gate, Exit.void)))))
            }
            return outcome
          })

        // The third start of one request is the second redelivery. chad gives up on it.
        if (kills >= 2) {
          yield* say("-# The last turn was cut off twice by a restart, so I stopped. Send it again if you still want it.")
          return yield* finish({ _tag: "Failed", reason: "Interrupted" }, false)
        }

        if (state.gate !== undefined) {
          const started = Date.now()
          yield* Deferred.await(state.gate)
          state.gate = undefined
          log("turn.waitedForHooks", { key: request.key, ms: Date.now() - started })
        }

        // Prompt chunks: rendered before every turn. A render that fails keeps the text the session last saw.
        const updates: Array<string> = []
        for (const p of registry.plugins) {
          if (!p.chunk || registry.unloaded.has(p.name)) continue
          const rendered = yield* p.chunk().pipe(Effect.timeoutOption(BUDGET.chunk), Effect.exit)
          if (Exit.isFailure(rendered) || Option.isNone(rendered.value)) {
            log("chunk.renderFailed", { plugin: p.name, kept: seen[p.name] ?? null })
            continue
          }
          const text = rendered.value.value
          if (seen[p.name] !== undefined && seen[p.name] !== text) updates.push("## " + p.name + "\n\n" + text)
          seen[p.name] = text
        }
        yield* sql`UPDATE sessions SET chunks = ${JSON.stringify(seen)} WHERE thread = ${threadId}`
        const prompts: Array<string> = []
        if (updates.length > 0) {
          prompts.push("<environment-update>\n" + updates.join("\n\n") + "\n</environment-update>")
          log("chunk.updateSent", { text: updates.join(" | ") })
        }
        for (const p of [...registry.plugins].sort((a, b) => a.name.localeCompare(b.name))) {
          if (!p.beforeTurn || registry.unloaded.has(p.name)) continue
          const text = yield* p.beforeTurn(turn).pipe(Effect.timeoutOption(BUDGET.beforeTurn), Effect.exit)
          if (Exit.isSuccess(text) && Option.isSome(text.value) && typeof text.value.value === "string") {
            prompts.push("<plugin-context plugin=\"" + p.name + "\">\n" + text.value.value + "\n</plugin-context>")
          }
        }
        prompts.push(turn.prompt)

        const status = yield* chat.post(thread(threadId), { markdown: "-# working", actions: [StopButton.of()] })
        log("status.posted", { id: status.id })
        const fiber = yield* Effect.forkChild(brain.runTurn(prompts))
        run.fiber = fiber
        const exit = yield* Fiber.await(fiber)
        run.fiber = undefined
        yield* Effect.ignore(chat.delete(thread(threadId), status.id))

        if (Exit.isSuccess(exit)) {
          const { answer, compacted, usage } = exit.value
          if (usage.length > 0) log("turn.usage", { key: request.key, calls: usage })
          if (request.plugin && answer.trim() === "[SILENT]") log("answer.silent", { key: request.key })
          else yield* say((request.mention ? "<@" + request.mention + "> " : "") + answer)
          return yield* finish({ _tag: "Answered", text: answer }, compacted)
        }
        if (run.stopped) {
          yield* say("-# stopped")
          return yield* finish({ _tag: "Stopped" }, false)
        }
        if (Exit.hasInterrupts(exit)) return yield* Effect.interrupt // shutdown or passivation: leave the request unprocessed
        log("turn.brainFailed", { key: request.key, cause: String(exit.cause).slice(0, 400) })
        yield* say("-# That turn failed.")
        return yield* finish({ _tag: "Failed", reason: "ModelError" }, false)
      }).pipe(
        // The handler itself is interrupted only when the entity is shut down: a graceful stop. A kill never gets here.
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
          log("message.delivered", { key: p.key, ms: Date.now() - p.sentAt, text: p.text.slice(0, 60) })
          if (p.text === "handler-defect") return yield* Effect.die(new Error("boom: a defect in the handler"))
          // A message that already joined a turn before a crash is not put into the history twice.
          const prior = yield* Effect.orDie(sql<{ state: string; outcome: string | null }>`SELECT state, outcome FROM turns WHERE key = ${p.key}`)
          if (prior[0]?.state === "steered") return { _tag: "Steered" } as Outcome
          // Cluster forgets a request once MessageRetention prunes it. chad's own row still knows the turn ended.
          if (prior[0]?.state === "ended") {
            log("message.alreadyEnded", { key: p.key, outcome: prior[0].outcome })
            return stored(prior[0].outcome)
          }
          while (true) {
            const current = state.running
            if (current === undefined) {
              return yield* runTurn({ key: p.key, origin: { _tag: "Message", text: p.text, userId: p.userId }, prompt: p.text, plugin: false }, take())
            }
            const result = yield* Effect.raceFirst(Effect.as(brain.steer(p.text), "steered" as const), Deferred.await(current.done))
            if (result === "steered") {
              yield* Effect.orDie(sql`INSERT OR REPLACE INTO turns (key, id, thread, origin, state) VALUES (${p.key}, ${randomUUID()}, ${threadId}, '{}', 'steered')`)
              log("message.steered", { key: p.key })
              return { _tag: "Steered" } as Outcome
            }
            if (result === "stopped") {
              log("message.dropped", { key: p.key })
              return { _tag: "Dropped" } as Outcome
            }
            log("message.turnEndedFirst", { key: p.key })
          }
        }),
      pluginTurn: (envelope) =>
        Effect.gen(function*() {
          const p = envelope.payload
          log("pluginTurn.delivered", { key: p.key, ms: Date.now() - p.sentAt })
          const prior = yield* Effect.orDie(sql<{ state: string; outcome: string | null }>`SELECT state, outcome FROM turns WHERE key = ${p.key}`)
          if (prior[0]?.state === "ended") {
            log("message.alreadyEnded", { key: p.key, outcome: prior[0].outcome })
            return stored(prior[0].outcome)
          }
          // A plugin turn waits for the session to be idle and never steers.
          while (state.running !== undefined) yield* Deferred.await(state.running.done)
          return yield* runTurn(
            { key: p.key, origin: { _tag: "Plugin", plugin: p.plugin, label: p.label, timer: p.timer }, prompt: p.prompt, plugin: true, mention: p.mention },
            take()
          )
        }),
      stop: (envelope) =>
        Effect.gen(function*() {
          const run = state.running
          log("stop.received", { by: envelope.payload.by, running: run !== undefined })
          if (run === undefined || run.fiber === undefined) return { stopped: false }
          run.stopped = true
          // Not awaited: the reply to a button click must not wait for clanka to unwind.
          Effect.runFork(Fiber.interrupt(run.fiber))
          return { stopped: true }
        }),
      hold: (envelope) =>
        Effect.gen(function*() {
          yield* Entity.keepAlive(true)
          log("keepAlive.on", { thread: threadId })
          yield* Effect.sleep(envelope.payload.ms).pipe(
            Effect.andThen(Entity.keepAlive(false)),
            Effect.andThen(Effect.sync(() => log("keepAlive.off", { thread: threadId }))),
            Effect.forkIn(activationScope)
          )
        }),
      peek: () => Effect.sync(() => ({ activation, ...brain.stats() }))
    }
  }),
  { concurrency: "unbounded", maxIdleTime: IDLE_MS, disableFatalDefects: true }
)

// --- the Timer entity: one address per plugin timer -------------------------

const nextRun = (row: { cron: string | null; every_ms: number | null }, after: number): number | undefined => {
  if (row.every_ms !== null) return after + row.every_ms
  if (row.cron !== null) return Cron.next(Cron.parseUnsafe(row.cron, "Pacific/Auckland"), new Date(after)).getTime()
  return undefined
}
const timerId = (plugin: string, name: string) => plugin + "/" + name

export const TimerLive = Timer.toLayer(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const makeSession = yield* Session.client
    const makeTimer = yield* Timer.client
    const read = (plugin: string, name: string) =>
      Effect.map(
        Effect.orDie(sql<{ thread: string; prompt: string; cron: string | null; every_ms: number | null; next_run: number }>`SELECT * FROM timers WHERE plugin = ${plugin} AND name = ${name}`),
        (rows) => rows[0]
      )
    return {
      fire: (envelope) =>
        Effect.gen(function*() {
          const { plugin, name, at } = envelope.payload
          log("timer.delivered", { timer: timerId(plugin, name), at, lateMs: Date.now() - at })
          let row = yield* read(plugin, name)
          // Cluster's message is only the wake-up. The row says whether this run is still wanted.
          if (row === undefined || row.next_run !== at) return void log("timer.stale", { timer: timerId(plugin, name), at })
          if (registry.unloaded.has(plugin)) {
            // Held: the handler stays open, so the request stays unprocessed and is redelivered after a restart.
            log("timer.held", { timer: timerId(plugin, name), at })
            yield* registry.awaitLoaded(plugin)
            row = yield* read(plugin, name)
            if (row === undefined || row.next_run !== at) return void log("timer.stale", { timer: timerId(plugin, name), at })
          }
          // One scheduled time is one turn: the key is the plugin, the timer and the time.
          const outcome = yield* makeSession(row.thread).pluginTurn(
            new PluginTurn({
              key: "timer/" + plugin + "/" + name + "/" + at,
              thread: row.thread,
              prompt: row.prompt,
              plugin,
              label: name,
              timer: { name, scheduledAt: at },
              sentAt: Date.now()
            })
          ).pipe(Effect.orDie)
          log("timer.turnEnded", { timer: timerId(plugin, name), at, outcome: outcome._tag })
          if (env.PROTO_PAUSE_BEFORE_NEXT) {
            log("timer.pauseBeforeNext", { timer: timerId(plugin, name), at })
            yield* Effect.sleep(Number(env.PROTO_PAUSE_BEFORE_NEXT))
          }
          // Checked again, so a cancel that landed during the run stays cancelled.
          const after = yield* read(plugin, name)
          if (after === undefined || after.next_run !== at) return void log("timer.cancelledDuringRun", { timer: timerId(plugin, name), at })
          let next = nextRun(after, at)
          if (next === undefined) {
            yield* Effect.orDie(sql`DELETE FROM timers WHERE plugin = ${plugin} AND name = ${name}`)
            return void log("timer.oneShotDone", { timer: timerId(plugin, name), at })
          }
          // Only the next run is stored, so however many were missed, one fires.
          const now = Date.now()
          while (after.every_ms !== null && next! + after.every_ms <= now) next = next! + after.every_ms
          yield* Effect.orDie(sql`UPDATE timers SET next_run = ${next} WHERE plugin = ${plugin} AND name = ${name}`)
          yield* makeTimer(timerId(plugin, name)).fire(new Fire({ plugin, name, at: next! }), { discard: true }).pipe(Effect.orDie)
          log("timer.nextSaved", { timer: timerId(plugin, name), at, next })
        })
    }
  }),
  { disableFatalDefects: true }
)

/** What the plugin API's Turns service would sit on. */
export const Turns = {
  start: (options: { thread: string; prompt: string; plugin: string; label: string; mention?: string; wait?: boolean }) =>
    Effect.gen(function*() {
      const makeSession = yield* Session.client
      const payload = new PluginTurn({ key: "start/" + randomUUID(), thread: options.thread, prompt: options.prompt, plugin: options.plugin, label: options.label, ...(options.mention ? { mention: options.mention } : {}), sentAt: Date.now() })
      return options.wait === false
        ? yield* makeSession(options.thread).pluginTurn(payload, { discard: true })
        : yield* makeSession(options.thread).pluginTurn(payload)
    }),
  clear: (plugin: string, name: string) =>
    Effect.gen(function*() {
      const sharding = yield* Sharding.Sharding
      const storage = yield* MessageStorage.MessageStorage
      const entityId = timerId(plugin, name) as any
      yield* storage.clearAddress(new EntityAddress({ entityType: Timer.type, entityId, shardId: sharding.getShardId(entityId, Timer.getShardGroup(entityId)) }))
    }),
  schedule: (options: { plugin: string; name: string; thread: string; prompt: string; at?: number; cron?: string; everyMs?: number }) =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const makeTimer = yield* Timer.client
      const next = options.at ?? nextRun({ cron: options.cron ?? null, every_ms: options.everyMs ?? null }, Date.now())!
      yield* sql`INSERT OR REPLACE INTO timers (plugin, name, thread, prompt, cron, every_ms, next_run) VALUES (${options.plugin}, ${options.name}, ${options.thread}, ${options.prompt}, ${options.cron ?? null}, ${options.everyMs ?? null}, ${next})`
      yield* Turns.clear(options.plugin, options.name)
      yield* makeTimer(timerId(options.plugin, options.name)).fire(new Fire({ plugin: options.plugin, name: options.name, at: next }), { discard: true })
      log("turns.scheduled", { timer: timerId(options.plugin, options.name), next })
    }),
  cancel: (plugin: string, name: string) =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM timers WHERE plugin = ${plugin} AND name = ${name}`
      yield* Turns.clear(plugin, name)
      log("turns.cancelled", { timer: timerId(plugin, name) })
    })
}

// --- the gateway handler and the Stop button --------------------------------

const GatewayLive = ChatHandler.layer((event) =>
  Effect.gen(function*() {
    if (event._tag !== "MessageCreated") return
    if (event.message.author.id !== OWNER) return void log("gateway.ignored", { author: event.message.author.id })
    const makeSession = yield* Session.client
    const chat = yield* Chat.Chat
    const text = event.message.text.trim()
    const started = Date.now()
    if (text === "/stop") {
      const result = yield* makeSession(event.thread.id).stop({ by: "command" }).pipe(Effect.orDie)
      if (!result.stopped) yield* Effect.orDie(chat.post(event.thread, { markdown: "-# Nothing is running." }))
      return
    }
    const key = ChatEvent.dedupeKey(event)
    // Refused only when the save fails.
    yield* makeSession(event.thread.id).message(
      new Incoming({ key, thread: event.thread.id, text, userId: event.message.author.id, sentAt: started }),
      { discard: true }
    ).pipe(Effect.mapError(() => new ChatHandler.NotAccepted()))
    log("gateway.saved", { key, ms: Date.now() - started })
  })
)

const ButtonsLive = Buttons.toLayer(Effect.gen(function*() {
  const makeSession = yield* Session.client
  return {
    stop: (click: any) =>
      Effect.gen(function*() {
        const started = Date.now()
        const result = yield* makeSession(click.thread.id).stop({ by: "button" }).pipe(Effect.orDie)
        log("button.stop", { stopped: result.stopped, ms: Date.now() - started })
        return ChatInteraction.ack
      })
  }
}))

// --- assembly. Later lines are built first and closed last. -----------------

const Model = OpenAiCompat.model(env.PROTO_MODEL ?? "gpt-5.6-luna", { reasoning: { effort: "low" } } as any).pipe(
  Layer.provide(OpenAiCompat.layerClient({
    apiKey: Redacted.make(env.CLANKA_OPENAI_API_KEY ?? ""),
    apiUrl: env.CLANKA_OPENAI_API_URL ?? ""
  }))
)

const RetentionLive = RETENTION_MS === undefined
  ? Layer.empty
  : Layer.mergeAll(
    MessageRetention.make({ entity: Session, retention: RETENTION_MS, interval: 1000 }),
    MessageRetention.make({ entity: Timer, retention: RETENTION_MS, interval: 1000 })
  )

export const HostLive = Layer.mergeAll(SessionLive, TimerLive, GatewayLive, ButtonsLive, RetentionLive).pipe(
  Layer.provideMerge(SingleRunner.layer({
    shardingConfig: env.PROTO_POLL ? { entityMessagePollInterval: Number(env.PROTO_POLL) } : {}
  })),
  Layer.provideMerge(HooksLive),
  Layer.provideMerge(ChatInteraction.layer()),
  Layer.provideMerge(ChatTest.layer()),
  Layer.provideMerge(TablesLive),
  Layer.provideMerge(Layer.mergeAll(
    Model,
    Agent.ConversationMode.layer(true),
    env.PROTO_COMPACT_THRESHOLD
      ? Compaction.CompactionConfig.layer({ thresholdTokens: Number(env.PROTO_COMPACT_THRESHOLD), keepRecentTokens: Number(env.PROTO_COMPACT_KEEP ?? 500) })
      : Layer.empty,
    // With its own model the summarizer outlives the turn that started it.
    env.PROTO_SUMMARIZER ? Compaction.layerSummarizerModel(Model as any) : Layer.empty
  )),
  Layer.provideMerge(Layer.mergeAll(SqliteClient.layer({ filename: DB }), NodeCrypto.layerDigest, NodeServices.layer, NodeHttpClient.layerUndici))
)
