// PROTOTYPE for "Credential tools run on real clanka and a browser sidecar" (TIM-554). Throwaway.
//
// The host from "The Session entity run on SingleRunner and SQLite" (TIM-543) as "The plugin swap run with
// live sessions" (TIM-552) left it, with the plugins taken out and these put in:
//   - the spawner wrap and the unix socket from "The chad CLI's socket, lock and session marker run for real" (TIM-550)
//   - masking at every output chad has (history rows, status message, log, turns table, chat posts, afterTurn)
//   - optionally the AgentExecutor wrap (PROTO_WRAP=1)
//   - `chad secret request`: the Enter button, the modal, the waits and the remembered buttons
//   - clanka's McpServers layer built from mcp.json, restarted when a secret it names changes
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
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
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as ChatTest from "effect/chat/ChatTest"
import * as ChatThread from "effect/chat/ChatThread"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as Entity from "effect/cluster/Entity"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as PrimaryKey from "effect/PrimaryKey"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { setLocal } from "./cli.ts"
import { log, mask, maskDeep, secrets } from "./log.ts"
import { ChadRpcs } from "./rpcs.ts"
import * as S from "./secrets.ts"

const env = process.env
export const DATA = S.DATA
export const DB = join(DATA, "chad.sqlite")
export const HOME = join(DATA, "home")
export const HOOKS = env.PROTO_HOOKS ?? join(DATA, "hooks.jsonl")
export const OWNER = "owner-1"
const PLATFORM = "test"
/** The better version of masking: also keep a value out of the model's context. */
const WRAP = env.PROTO_WRAP === "1"
/** 5 minutes, a constant in chad. Shortened by the scenarios that are not about the wait itself. */
const REQUEST_WAIT = Number(env.PROTO_REQUEST_WAIT_MS ?? 300_000)
mkdirSync(HOME, { recursive: true })
mkdirSync(join(DATA, "state"), { recursive: true })

// --- the SQLite tables chad owns, next to cluster's own ---------------------

const TablesLive = Layer.effectDiscard(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS sessions (thread TEXT PRIMARY KEY, id TEXT NOT NULL, environment TEXT)`
  yield* sql`CREATE TABLE IF NOT EXISTS session_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, message TEXT NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS turns (key TEXT PRIMARY KEY, id TEXT NOT NULL, thread TEXT NOT NULL, origin TEXT NOT NULL, starts INTEGER NOT NULL DEFAULT 0, cuts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new', outcome TEXT)`
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

const thread = (id: string) => ChatThread.make(PLATFORM, id)

// --- the scripted model -------------------------------------------------------
//
// It reads its behaviour from the last user message that carries PLAN:{"steps":[...]}. Each step is a
// script. @@NAME@@ in a step is replaced by the stored value of NAME when the model emits the script:
// that is a model that knows a value and writes it into a script, without the owner's message
// carrying it. Every call logs which stored values its prompt contained, by name.

const allStrings = (value: unknown): Array<string> => {
  const out: Array<string> = []
  const seen = new Set<unknown>()
  const go = (v: unknown) => {
    if (typeof v === "string") return void out.push(v)
    if (v === null || typeof v !== "object" || seen.has(v)) return
    seen.add(v)
    if (v instanceof Uint8Array) return
    for (const x of Array.isArray(v) ? v : Object.values(v)) go(x)
  }
  go(value)
  return out
}
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
      let plan: { steps: Array<string>; complete?: boolean; fail?: boolean } = { steps: [] }
      for (let i = messages.length - 1; i >= 0 && at === -1; i--) {
        if (messages[i].role !== "user") continue
        const text = messageText(messages[i])
        if (!text.includes("PLAN:") || text.trimStart().startsWith("<")) continue
        try {
          plan = JSON.parse(text.slice(text.indexOf("PLAN:") + 5).split("\n")[0])
          at = i
        } catch {}
      }
      const call = ++modelCalls
      const whole = allStrings(messages).join("\n")
      const afterPlan = at === -1 ? [] : messages.slice(at + 1)
      log("model.call", {
        call,
        messages: messages.length,
        // By name only. This line is the evidence for what reached the model.
        sees: S.found(secrets().store, whole),
        seesMasked: [...new Set(whole.match(/<secret:[A-Z0-9_]+>/g) ?? [])],
        // What came after the plan, in order, so a steering message can be placed.
        tail: afterPlan.map((m) => m.role + ":" + (m.role === "user" ? messageText(m).slice(0, 80) : m.role === "tool" ? "result" : "call"))
      })
      const text = (delta: string) =>
        Stream.make<Array<any>>({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta }, { type: "text-end", id: "t" }) as any
      if (at === -1) return text("no plan")
      const results: Array<string> = []
      for (const message of afterPlan) {
        if (message.role !== "tool") continue
        for (const part of message.content as ReadonlyArray<any>) if (part.type === "tool-result") results.push(String(part.result))
      }
      if (results.length < plan.steps.length) {
        const store = secrets().store
        const script = plan.steps[results.length].replace(/@@(json:)?([A-Z][A-Z0-9_]*)@@/g, (_, json, name) => (json ? JSON.stringify(store[name]?.value ?? "") : store[name]?.value ?? ""))
        return Stream.make({ type: "tool-call", id: "call-" + call, name: "execute", params: { script } }) as any
      }
      if (plan.fail) return Stream.die(new Error("the provider refused the request: " + results[results.length - 1])) as any
      const answer = "RESULTS " + JSON.stringify(results)
      if (plan.complete) {
        return Stream.make({ type: "tool-call", id: "call-" + call, name: "execute", params: { script: "await taskComplete(" + JSON.stringify(answer) + ")" } }) as any
      }
      return text(answer)
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
  Tool.make("mark", { description: "Prototype: write a line to the event log.", parameters: Schema.Struct({ label: Schema.String }), success: Schema.String }),
  Tool.make("hold", { description: "Prototype: wait until the scenario releases this label.", parameters: Schema.Struct({ label: Schema.String }), success: Schema.String })
)
const latches = new Map<string, Deferred.Deferred<void>>()
const latch = (label: string) => {
  let d = latches.get(label)
  if (d === undefined) latches.set(label, d = Deferred.makeUnsafe<void>())
  return d
}
export const release = (label: string) => Effect.sync(() => void Deferred.doneUnsafe(latch(label), Exit.void))

const MessageJson = Schema.toCodecJson(Prompt.Message)
const encodeMessage = Schema.encodeSync(MessageJson)
const decodeMessage = Schema.decodeSync(MessageJson)
const EnvironmentJson = Schema.toCodecJson(AgentExecutor.ExecutionEnvironment)

// --- the spawner wrap from TIM-550: every process a session starts gets CHAD_SESSION -------------

const sessionSpawner = (id: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function*() {
      const inner = yield* ChildProcessSpawner.ChildProcessSpawner
      const go = (cmd: ChildProcess.Command): ChildProcess.Command => {
        if (cmd._tag === "PipedCommand") return ChildProcess.pipeTo(go(cmd.left), go(cmd.right), cmd.options)
        const hadEnv = cmd.options.env !== undefined
        return ChildProcess.make(cmd.command, cmd.args as any, { ...cmd.options, env: { ...cmd.options.env, CHAD_SESSION: id }, extendEnv: hadEnv ? cmd.options.extendEnv : true })
      }
      return ChildProcessSpawner.make((cmd) => {
        if (cmd._tag === "StandardCommand") log("spawner.spawn", { session: id, command: cmd.command, args: cmd.args })
        return inner.spawn(go(cmd))
      })
    })
  )

// --- the AgentExecutor wrap (item 19 of TIM-546) ------------------------------------------------
//
// clanka has no redaction hook. A script's output reaches the model, the ScriptOutput event and the
// history only through the string stream AgentExecutor.execute returns, and Agent.ts joins that stream
// whole before it uses it. So the wrap joins it first and masks it once. Masking chunk by chunk would
// miss a value that straddles two chunks.

const wrapExecutor = (inner: AgentExecutor.AgentExecutor["Service"]): AgentExecutor.AgentExecutor["Service"] =>
  AgentExecutor.AgentExecutor.of({
    ...inner,
    execute: (options) => Stream.unwrap(Effect.map(Stream.mkString(inner.execute(options)), (output) => Stream.make(mask(output))))
  })

// --- chat, and the things that are module-wide because the socket, the buttons and the sessions all use them ----

let chat: Chat.Chat["Service"]
const queue = Semaphore.makeUnsafe(1)
/** Every post and edit chad makes goes through these two. */
const post = (threadId: string, markdown: string, actions?: ReadonlyArray<any>) =>
  chat.post(thread(threadId), { markdown: mask(markdown), ...(actions ? { actions } : {}) })
const edit = (threadId: string, messageId: string, markdown: string, why: string) =>
  chat.edit(thread(threadId), messageId, { markdown: mask(markdown) }).pipe(
    Effect.exit,
    Effect.map((exit) => log("chat.edited", { thread: threadId, messageId, markdown, why, ok: Exit.isSuccess(exit) }))
  )

/** The sessions with a turn running, so `request` can tell whether an owner is present. */
const running = new Map<string, { origin: "owner" | "plugin"; thread: string }>()
const threadOf = new Map<string, string>()

// --- MCP: clanka's layer, built from mcp.json, behind one wrapper every Agent is given --------------

const MCP_FILE = join(DATA, "mcp.json")
interface McpBuild {
  readonly service: McpServers.McpServers["Service"]
  readonly scope: Scope.Closeable
  readonly names: ReadonlySet<string>
}
let mcp: McpBuild | undefined
let mcpFirst: McpBuild | undefined
const mcpBuild = Effect.gen(function*() {
  if (!existsSync(MCP_FILE)) return undefined
  const raw = JSON.parse(readFileSync(MCP_FILE, "utf8")).mcpServers ?? {}
  const store = S.load()
  const names = new Set<string>()
  // ${NAME} resolves in the secret store first and then the process environment (TIM-537).
  const expand = (text: string) =>
    text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => {
      names.add(name)
      if (store[name]?.kind === "totp") throw new Error("${" + name + "} names a TOTP secret")
      return store[name]?.value ?? env[name] ?? ""
    })
  const config: Record<string, any> = {}
  for (const [name, entry] of Object.entries<any>(raw)) {
    config[name] = Schema.decodeUnknownSync(McpServers.McpServerConfig)({
      type: "stdio",
      command: expand(entry.command),
      args: (entry.args ?? []).map(expand),
      env: Object.fromEntries(Object.entries<string>(entry.env ?? {}).map(([k, v]) => [k, expand(v)])),
      ...(entry.connectTimeout ? { connectTimeout: entry.connectTimeout } : {})
    })
  }
  const scope = yield* Scope.make()
  const started = Date.now()
  const context = yield* Layer.buildWithScope(McpServers.layer(config), scope)
  const service = Context.get(context, McpServers.McpServers)
  const status = yield* service.status
  log("mcp.built", {
    ms: Date.now() - started,
    names: [...names],
    status: Object.fromEntries(Object.entries(status).map(([k, s]: [string, any]) => [k, s._tag === "Connected" ? { connected: true, tools: s.tools.length } : { connected: false, error: s.error }]))
  })
  return { service, scope, names } as McpBuild
})
/** What an Agent holds for its whole life. A call goes to whichever layer is current when it is made. */
const mcpWrapper = (): McpServers.McpServers["Service"] =>
  McpServers.McpServers.of({
    status: Effect.suspend(() => mcp!.service.status),
    prompt: mcpFirst!.service.prompt,
    dts: mcpFirst!.service.dts,
    handlers: (onImage) =>
      Object.fromEntries(
        Object.keys(mcpFirst!.service.handlers(onImage)).map((key) => [
          key,
          (params: unknown) => Effect.suspend(() => mcp!.service.handlers(onImage)[key]?.(params) ?? Effect.fail("MCP tool " + key + " is gone"))
        ])
      )
  })
/** A changed secret restarts the servers that name it. The bare restart: close, then build. The gate and the drain are another ticket's. */
const mcpRestartFor = (name: string) =>
  Effect.gen(function*() {
    if (mcp === undefined || !mcp.names.has(name)) return [] as Array<string>
    const started = Date.now()
    log("mcp.restarting", { because: name })
    yield* Scope.close(mcp.scope, Exit.void)
    const closed = Date.now()
    mcp = yield* mcpBuild
    log("mcp.restarted", { because: name, closeMs: closed - started, buildMs: Date.now() - closed })
    return Object.keys(yield* mcp!.service.status)
  })

// --- saving a secret: one path, through the daemon's queue -----------------------------------------

interface Remembered {
  readonly key: string
  readonly name: string
  readonly kind: "plain" | "totp"
  readonly thread: string
  readonly messageId: string
  readonly askedAt: number
  readonly waiters: Set<Deferred.Deferred<"saved" | "owner">>
}
/** Unused buttons, by thread and name. In memory only. */
const remembered = new Map<string, Remembered>()
interface CodeWait {
  readonly thread: string
  readonly messageId: string
  readonly done: Deferred.Deferred<{ code: string } | "owner">
}
const codeWaits = new Map<string, CodeWait>()
let codeSeq = 0

export const saveSecret = (o: { name: string; value: string; totp: boolean; note?: string | undefined; via: string; origin?: { thread: string; messageId: string } }) =>
  queue.withPermits(1)(Effect.gen(function*() {
    if (o.totp && mcp?.names.has(o.name)) return yield* Effect.fail("mcp.json names " + o.name + ", so it cannot become a TOTP secret")
    const applied = setLocal(o.name, o.value, o.totp, o.note)
    if ("error" in applied) return yield* Effect.fail(applied.error)
    log("secret.saved", { name: o.name, via: o.via, kind: o.totp ? "totp" : "plain", replaced: applied.replaced, short: applied.short })
    const restarted = yield* mcpRestartFor(o.name)
    // Every remembered button for the name, in every thread.
    let buttons = 0
    const edited = new Set<string>()
    for (const r of [...remembered.values()].filter((r) => r.name === o.name)) {
      remembered.delete(r.key)
      yield* edit(r.thread, r.messageId, "Saved " + o.name, "saved")
      edited.add(r.messageId)
      buttons++
      for (const waiter of r.waiters) Deferred.doneUnsafe(waiter, Exit.succeed("saved" as const))
    }
    // The button that was clicked, when the daemon no longer remembers it.
    if (o.origin && !edited.has(o.origin.messageId)) yield* edit(o.origin.thread, o.origin.messageId, "Saved " + o.name, "saved-from-click")
    return { ...applied, restarted, buttons }
  }))

// --- the Enter button and the modal ----------------------------------------------------------------

const Ref = Schema.Struct({ n: Schema.String, k: Schema.Literals(["plain", "totp", "code"]) })
const Enter = ChatInteraction.button("enter", { label: "Enter", style: "primary", value: Ref })
const EnterModal = ChatInteraction.modal("enter-modal", { title: "Enter a secret", metadata: Ref, fields: { value: ChatInteraction.textInput({ label: "Value" }) } })
/** The definition's title and label are fixed, so the reply is built by hand to name the secret. Discord: title 45, label 45. */
const openModal = (ref: typeof Ref.Type): ChatInteraction.OpenModal => {
  const opened = EnterModal.open({ metadata: ref })
  const label = ref.k === "code" ? "One-off code" : ref.k === "totp" ? ref.n + " (TOTP seed or otpauth:// URI)" : ref.n
  return { ...opened, modal: { ...opened.modal, elements: opened.modal.elements.map((e: any) => (e._tag === "TextInput" ? { ...e, label: label.slice(0, 45) } : e)) } }
}

const InteractionsLive = ChatInteraction.group(Enter, EnterModal).toLayer({
  enter: (click) =>
    Effect.sync(() => {
      if (click.userId !== OWNER) {
        log("click.ignored", { by: click.userId, name: click.value.n })
        return ChatInteraction.ack
      }
      log("click.opened", { by: click.userId, name: click.value.n, kind: click.value.k })
      return openModal(click.value)
    }),
  "enter-modal": (submit) =>
    Effect.gen(function*() {
      const { n: name, k: kind } = submit.metadata
      const value = submit.values.value
      if (submit.userId !== OWNER) {
        log("submit.ignored", { by: submit.userId, name })
        return ChatInteraction.close
      }
      if (kind === "code") {
        const wait = codeWaits.get(name)
        log("submit.code", { request: name, pending: wait !== undefined })
        if (wait !== undefined) Deferred.doneUnsafe(wait.done, Exit.succeed({ code: value }))
        return ChatInteraction.close
      }
      // What can be said inside the 3 seconds is said here. The save itself waits for the daemon's queue.
      if (kind === "totp") {
        const parsed = S.parseTotp(value)
        if ("error" in parsed) return ChatInteraction.errors({ value: parsed.error })
      }
      const save = saveSecret({ name, value, totp: kind === "totp", via: "modal", origin: { thread: submit.thread.id, messageId: submit.messageId } }).pipe(
        Effect.exit,
        Effect.map((exit) => log("submit.saved", { name, ok: Exit.isSuccess(exit), error: Exit.isSuccess(exit) ? undefined : String((exit as any).cause).slice(0, 200) }))
      )
      if (env.PROTO_SUBMIT_AWAITS_QUEUE === "1") yield* save
      else yield* Effect.forkDetach(save)
      return ChatInteraction.close
    })
}).pipe(Layer.provideMerge(ChatInteraction.layer()))

// --- `chad secret request` and the rest of the socket ------------------------------------------------

const ended = (exit: number, message: string) => Effect.fail({ _tag: "Ended" as const, exit, message })
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19) + " UTC"
// Item 10: the message reads as the agent asking. It names the session and quotes -m as the agent's words.
const askText = (session: string, what: string, why: string | undefined, note: string | undefined) =>
  "The agent in session " + session + " asks for " + what + (note ? " (" + note + ")" : "") + "." +
  (why ? "\nIt says: \"" + why + "\"" : "") + "\nPress Enter to type it."
/** An owner message in the thread ends what is pending there, before the message steers. */
const ownerSpoke = (threadId: string) =>
  Effect.sync(() => {
    let endedCount = 0
    for (const r of remembered.values()) {
      if (r.thread !== threadId) continue
      for (const waiter of r.waiters) (Deferred.doneUnsafe(waiter, Exit.succeed("owner" as const)), endedCount++)
    }
    for (const wait of codeWaits.values()) if (wait.thread === threadId) (Deferred.doneUnsafe(wait.done, Exit.succeed("owner" as const)), endedCount++)
    if (endedCount > 0) log("request.endedByOwner", { thread: threadId, ended: endedCount })
  })
const askStored = (o: { thread: string; session: string | undefined; name: string; kind: "plain" | "totp"; note?: string | undefined; why?: string | undefined; ping: boolean }) =>
  Effect.gen(function*() {
    const what = "a secret named " + o.name + (o.kind === "totp" ? " (a TOTP seed)" : "")
    const text = o.session === undefined ? "Press Enter to save " + what + "." : askText(o.session, what, o.why, o.note)
    const posted = yield* post(o.thread, (o.ping ? "<@" + OWNER + "> " : "") + text, [Enter.of({ n: o.name, k: o.kind })])
    const r: Remembered = { key: o.thread + "\n" + o.name, name: o.name, kind: o.kind, thread: o.thread, messageId: posted.id, askedAt: Date.now(), waiters: new Set() }
    remembered.set(r.key, r)
    log("request.posted", { thread: o.thread, name: o.name, kind: o.kind, messageId: posted.id, ping: o.ping })
    return r
  })

const RpcHandlers = ChadRpcs.toLayer(Effect.sync(() =>
  ChadRpcs.of({
    Ping: () => Effect.succeed("pong"),
    SecretSet: (p, { headers }) =>
      saveSecret({ name: p.name, value: p.value, totp: p.totp, note: p.note, via: headers["chad-session"] ? "cli in session " + headers["chad-session"] : "cli" }).pipe(
        Effect.catch((error) => ended(1, "chad secret set: " + error))
      ),
    SecretRm: (p) =>
      queue.withPermits(1)(Effect.suspend(() => {
        const store = S.load()
        if (store[p.name] === undefined) return ended(1, "chad secret rm: no secret named " + p.name)
        delete store[p.name]
        S.save(store)
        log("secret.removed", { name: p.name })
        return Effect.succeed(true)
      })),
    SecretRequest: (p, { headers }) =>
      Effect.gen(function*() {
        const session = headers["chad-session"]
        const threadId = session === undefined ? undefined : threadOf.get(session)
        if (session === undefined || threadId === undefined) {
          return yield* ended(1, "chad secret request: there is no chat thread to ask in here. Save it yourself with: chad secret set " + (p.name ?? "NAME"))
        }
        const ownerPresent = running.get(session)?.origin === "owner"
        log("request.received", { session, name: p.name, kind: p.kind, noWait: p.noWait, ownerPresent })
        const waitSeconds = Math.round(REQUEST_WAIT / 1000)

        if (p.kind === "code") {
          if (!ownerPresent) return yield* ended(1, "chad secret request --code: no owner is present in this turn, so nobody can type a code. Nothing was posted.")
          const id = "c" + ++codeSeq
          const posted = yield* Effect.orDie(post(threadId, askText(session, "a one-off code", p.why, p.note), [Enter.of({ n: id, k: "code" })]))
          const done = Deferred.makeUnsafe<{ code: string } | "owner">()
          codeWaits.set(id, { thread: threadId, messageId: posted.id, done })
          log("request.posted", { thread: threadId, code: id, messageId: posted.id })
          const result = yield* Effect.raceFirst(Deferred.await(done), Effect.as(Effect.sleep(REQUEST_WAIT), "timeout" as const)).pipe(
            // The client went away: /stop killed the command, or the script was cut.
            Effect.onInterrupt(() => edit(threadId, posted.id, "Cancelled", "client-dropped")),
            Effect.ensuring(Effect.sync(() => void codeWaits.delete(id)))
          )
          if (result === "timeout") {
            yield* edit(threadId, posted.id, "Timed out", "timeout")
            return yield* ended(1, "chad secret request: timed out after " + waitSeconds + " s")
          }
          if (result === "owner") {
            yield* edit(threadId, posted.id, "Answered in chat", "owner-replied")
            return yield* ended(1, "chad secret request: owner replied in chat instead")
          }
          yield* edit(threadId, posted.id, "Code received", "code")
          return { result: "code" as const, code: result.code, message: "" }
        }

        const name = p.name!
        let r = remembered.get(threadId + "\n" + name)
        const repeat = r !== undefined
        if (r === undefined) {
          const asked = yield* Effect.exit(askStored({ thread: threadId, session, name, kind: p.kind, note: p.note, why: p.why, ping: !ownerPresent }))
          if (Exit.isFailure(asked)) {
            const reason = (Option.getOrUndefined(Exit.findErrorOption(asked)) as any)?.reason?._tag
            log("request.postFailed", { name, reason })
            return yield* ended(1, "chad secret request: the message could not be posted (" + reason + ")")
          }
          r = asked.value
        } else log("request.repeat", { thread: threadId, name, askedAt: r.askedAt })
        if (!ownerPresent) {
          return yield* ended(1, repeat ? "chad secret request: already asked at " + clock(r.askedAt) : "chad secret request: asked for " + name + ", not waiting: no owner is present in this turn")
        }
        if (p.noWait) return { result: "asked" as const, message: repeat ? "Already asked for " + name + " at " + clock(r.askedAt) : "Asked for " + name }
        const done = Deferred.makeUnsafe<"saved" | "owner">()
        r.waiters.add(done)
        const waiters = r.waiters
        const result = yield* Effect.raceFirst(Deferred.await(done), Effect.as(Effect.sleep(REQUEST_WAIT), "timeout" as const)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => log("request.clientDropped", { name, thread: threadId }))),
          Effect.ensuring(Effect.sync(() => void waiters.delete(done)))
        )
        if (result === "timeout") {
          log("request.timeout", { name, thread: threadId })
          return yield* ended(1, "chad secret request: timed out after " + waitSeconds + " s. The button is still there, so " + name + " can still be saved.")
        }
        if (result === "owner") return yield* ended(1, "chad secret request: owner replied in chat instead")
        return { result: "saved" as const, message: "Saved " + name }
      })
  })
))

const sockAbs = join(DATA, "state", "chad.sock")
const sockPath = Buffer.byteLength(sockAbs) > 107 ? relative(process.cwd(), sockAbs) : sockAbs
const SocketLive = Layer.unwrap(Effect.sync(() => {
  rmSync(sockAbs, { force: true })
  return RpcServer.layer(ChadRpcs).pipe(
    Layer.provide(RpcHandlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocketServer.layer({ path: sockPath })),
    Layer.merge(Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => rmSync(sockAbs, { force: true })))))
  )
}))

// --- one session's clanka -----------------------------------------------------

const STATUS_CHARS = 300
/** Mask first, cut second. The other order can leave the first half of a value in the status message. */
export const statusText = (source: string, masker: (s: string) => string = mask) => {
  const masked = masker(source)
  return "-# running\n" + (masked.length > STATUS_CHARS ? masked.slice(0, STATUS_CHARS) + "…" : masked)
}

const makeBrain = (row: { id: string; thread: string; environment: string | null }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const directory = join(HOME, row.id)
    mkdirSync(directory, { recursive: true })
    const base = yield* Layer.build(AgentExecutor.layerLocal({ directory, ...(env.PROTO_SCRIPT_TIMEOUT_MS ? { limits: { scriptTimeout: Number(env.PROTO_SCRIPT_TIMEOUT_MS) } } : {}) }).pipe(Layer.provide(sessionSpawner(row.id))))
    const inner = Context.get(base, AgentExecutor.AgentExecutor)
    const executor = WRAP ? wrapExecutor(inner) : inner

    let agent: Agent.Agent | undefined
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const build = Effect.gen(function*() {
      const handlers = {
        mark: ({ label }: { label: string }) => Effect.sync(() => (log("script.mark", { session: row.id, label }), "marked")),
        hold: ({ label }: { label: string }) => Effect.as(Deferred.await(latch(label)), "released")
      }
      const context = yield* Layer.buildWithScope((CoreTools as any).toLayer(handlers) as Layer.Layer<any>, scope)
      let make: Effect.Effect<Agent.Agent, never, any> = (Agent.makeWith({ loopTools: CoreTools as any, skills: [], instructions: Option.none() }) as any).pipe(
        Effect.provideContext(context),
        Effect.provideService(AgentExecutor.AgentExecutor, executor)
      )
      if (mcpFirst !== undefined) make = Effect.provideService(make, McpServers.McpServers, mcpWrapper())
      const next: Agent.Agent = yield* Scope.provide(make as Effect.Effect<Agent.Agent, never, Scope.Scope>, scope)
      const stored = yield* Effect.orDie(sql<{ message: string }>`SELECT message FROM session_messages WHERE session = ${row.id} ORDER BY seq`)
      if (stored.length > 0) {
        MutableRef.set(next.history, Prompt.fromMessages(stored.map((r) => decodeMessage(JSON.parse(r.message)))))
        if (row.environment !== null) MutableRef.set(next.environment, Schema.decodeSync(EnvironmentJson)(JSON.parse(row.environment)))
        log("session.restored", { session: row.id, messages: stored.length })
      }
      agent = next
      log("agent.built", { session: row.id, wrap: WRAP, mcp: mcpFirst !== undefined })
    })

    return {
      steer: (text: string) => (agent ? agent.steer(text) : Effect.never),
      runTurn: (prompts: ReadonlyArray<string>, onMessages: (messages: Array<unknown>) => void, status: (source: string) => Effect.Effect<void>) =>
        Effect.gen(function*() {
          if (agent === undefined) yield* build
          const stream = yield* agent!.send({
            prompt: prompts.map((content) => ({ role: "user" as const, content })),
            system: (options) => "You are chad.\n\n" + options.toolInstructions
          })
          let source = ""
          const answer = yield* stream.pipe(
            Stream.runForEach((part: any) =>
              Effect.gen(function*() {
                switch (part._tag) {
                  case "HistoryAppended": {
                    // The history rows chad writes. Masked as a structure, then serialised.
                    const rows = part.messages.map((message: Prompt.Message) => maskDeep(encodeMessage(message)))
                    for (const message of rows) yield* sql`INSERT INTO session_messages (session, message) VALUES (${row.id}, ${JSON.stringify(message)})`
                    onMessages(rows)
                    break
                  }
                  case "ScriptStart":
                    source = ""
                    break
                  case "ScriptDelta":
                    source += part.delta
                    break
                  case "ScriptEnd":
                    if (source !== "") yield* status(source)
                    source = ""
                    break
                  case "ScriptOutput":
                    log("brain.scriptOutput", { session: row.id, output: String(part.output).slice(0, 4000) })
                    break
                }
              }).pipe(Effect.orDie)
            ),
            Effect.as("(the stream ended without an answer)"),
            Effect.catchTag("AgentFinished", (finished: any) => Effect.succeed(String(finished.summary)))
          )
          yield* Effect.orDie(sql`UPDATE sessions SET environment = ${JSON.stringify(Schema.encodeSync(EnvironmentJson)(agent!.environment.current))} WHERE thread = ${row.thread}`)
          return answer as string
        }).pipe(Effect.scoped)
    }
  })

// --- the Session entity -----------------------------------------------------

interface Run {
  readonly done: Deferred.Deferred<"ended" | "stopped">
  fiber: Fiber.Fiber<any, any> | undefined
  stopped: boolean
}

/** A stand-in for a plugin's afterTurn hook. It writes down exactly what it was given, unmasked by itself. */
const afterTurn = (payload: unknown) => appendFileSync(HOOKS, JSON.stringify(payload) + "\n")

export const SessionLive = Session.toLayer(
  Effect.gen(function*() {
    const address = yield* Entity.CurrentAddress
    const threadId = address.entityId as string
    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT OR IGNORE INTO sessions (thread, id) VALUES (${threadId}, ${"s-" + threadId})`.pipe(Effect.orDie)
    const [row] = yield* Effect.orDie(sql<{ id: string; thread: string; environment: string | null }>`SELECT * FROM sessions WHERE thread = ${threadId}`)
    threadOf.set(row.id, threadId)
    const brain = yield* makeBrain(row)
    log("session.activated", { thread: threadId, session: row.id })

    const state = { running: undefined as Run | undefined }
    const say = (markdown: string) => Effect.orDie(post(threadId, markdown))

    interface Request {
      readonly key: string
      readonly origin: { _tag: "Message" | "Plugin"; text?: string; plugin?: string }
      readonly prompt: string
    }

    const runTurn = (request: Request, run: Run) =>
      Effect.gen(function*() {
        yield* sql`INSERT OR IGNORE INTO turns (key, id, thread, origin) VALUES (${request.key}, ${randomUUID()}, ${threadId}, ${JSON.stringify(maskDeep(request.origin))})`
        yield* sql`UPDATE turns SET starts = starts + 1, state = 'running' WHERE key = ${request.key}`
        const [t] = yield* sql<{ id: string; starts: number; cuts: number }>`SELECT id, starts, cuts FROM turns WHERE key = ${request.key}`
        log("turn.start", { key: request.key, session: row.id, turn: t.id, origin: request.origin._tag })
        running.set(row.id, { origin: request.origin._tag === "Message" ? "owner" : "plugin", thread: threadId })
        const messages: Array<unknown> = []

        const finish = (raw: Outcome) =>
          Effect.gen(function*() {
            // Masked once, here: the turns table, the log, the hooks and the entity's reply all get this value.
            const outcome = maskDeep(raw)
            yield* sql`UPDATE turns SET state = 'ended', outcome = ${JSON.stringify(outcome)} WHERE key = ${request.key}`
            log("turn.end", { key: request.key, session: row.id, turn: t.id, outcome })
            afterTurn({ hook: "afterTurn", session: row.id, turn: t.id, outcome, messages })
            return outcome
          })

        const status = yield* Effect.orDie(post(threadId, "-# working"))
        const fiber = yield* Effect.forkChild(
          brain.runTurn([request.prompt], (rows) => void messages.push(...rows), (source) => edit(threadId, status.id, statusText(source), "status"))
        )
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
        const reason = String(exit.cause).slice(0, 600)
        yield* say("-# That turn failed: " + reason.slice(0, 200))
        return yield* finish({ _tag: "Failed", reason })
      }).pipe(
        Effect.orDie,
        Effect.ensuring(Effect.sync(() => {
          running.delete(row.id)
          state.running = undefined
          Deferred.doneUnsafe(run.done, Exit.succeed(run.stopped ? "stopped" as const : "ended" as const))
        }))
      )

    const take = (): Run => (state.running = { done: Deferred.makeUnsafe(), fiber: undefined, stopped: false })

    return {
      message: (envelope) =>
        Effect.gen(function*() {
          const p = envelope.payload
          log("message.delivered", { key: p.key, session: row.id })
          const prior = yield* Effect.orDie(sql<{ state: string; outcome: string | null }>`SELECT state, outcome FROM turns WHERE key = ${p.key}`)
          if (prior[0]?.state === "steered") return { _tag: "Steered" } as Outcome
          if (prior[0]?.state === "ended") return JSON.parse(prior[0].outcome!) as Outcome
          while (true) {
            const current = state.running
            if (current === undefined) {
              return yield* runTurn({ key: p.key, origin: { _tag: "Message", text: p.text }, prompt: p.text }, take())
            }
            // TIM-546 item 12: the message ends a pending request first, then steers as usual.
            yield* ownerSpoke(threadId)
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
          while (state.running !== undefined) yield* Deferred.await(state.running.done)
          return yield* runTurn({ key: p.key, origin: { _tag: "Plugin", plugin: p.plugin }, prompt: p.prompt }, take())
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

// --- the gateway handler ----------------------------------------------------

const GatewayLive = ChatHandler.layer((event) =>
  Effect.gen(function*() {
    if (event._tag !== "MessageCreated") return
    if (event.message.author.id !== OWNER) return
    const makeSession = yield* Session.client
    const raw = event.message.text.trim()
    if (raw === "/stop") {
      yield* makeSession(event.thread.id).stop({ by: "command" }).pipe(Effect.orDie)
      return
    }
    // Item 15: /secret is plain text like /new and never reaches the session.
    if (raw === "/secret" || raw.startsWith("/secret ")) {
      const [, name, kind] = raw.split(/\s+/)
      if (name === undefined) {
        const lines = Object.entries(S.load()).map(([n, e]) => [n, e.kind, e.note ?? "-", e.date.slice(0, 10)].join("  "))
        yield* Effect.orDie(post(event.thread.id, lines.length > 0 ? lines.join("\n") : "No secrets."))
      } else if (!S.NAME.test(name)) yield* Effect.orDie(post(event.thread.id, "A secret's name must match " + S.NAME.source))
      else if (!remembered.has(event.thread.id + "\n" + name)) {
        yield* Effect.orDie(askStored({ thread: event.thread.id, session: undefined, name, kind: kind === "totp" ? "totp" : "plain", ping: false }))
      }
      log("gateway.secretCommand", { thread: event.thread.id, name })
      return
    }
    // A stored value the owner types is masked before the session and cluster's message storage see it.
    const text = env.PROTO_NO_GATEWAY_MASK === "1" ? raw : mask(raw)
    const key = ChatEvent.dedupeKey(event)
    yield* makeSession(event.thread.id).message(
      new Incoming({ key, thread: event.thread.id, text, userId: event.message.author.id, sentAt: Date.now() }),
      { discard: true }
    ).pipe(Effect.mapError(() => new ChatHandler.NotAccepted()))
  })
)

// --- assembly. Later lines are built first and closed last. -----------------

const CoreLive = Layer.effectDiscard(Effect.gen(function*() {
  chat = yield* Chat.Chat
  mcp = mcpFirst = yield* mcpBuild
  yield* Effect.addFinalizer(() => (mcp ? Scope.close(mcp.scope, Exit.void) : Effect.void))
}))

/** What a scenario may reach into. */
export const Test = {
  /** As a restart would: the daemon forgets every button it posted. */
  forgetButtons: Effect.sync(() => {
    const n = remembered.size
    remembered.clear()
    log("test.forgotButtons", { n })
  }),
  /** Something else holds the daemon's queue, as an apply does. */
  holdQueue: (ms: number) => Effect.forkDetach(queue.withPermits(1)(Effect.andThen(Effect.sync(() => log("test.queueHeld", { ms })), Effect.sleep(ms)))),
  remembered: () => [...remembered.values()].map((r) => ({ thread: r.thread, name: r.name, messageId: r.messageId })),
  pluginTurn: (threadId: string, prompt: string) =>
    Effect.gen(function*() {
      const makeSession = yield* Session.client
      return yield* makeSession(threadId).pluginTurn(new PluginTurn({ key: "plugin/" + randomUUID(), thread: threadId, prompt, plugin: "cron", sentAt: Date.now() }))
    })
}

export const HostLive = Layer.mergeAll(SessionLive, GatewayLive, SocketLive).pipe(
  Layer.provideMerge(SingleRunner.layer({ shardingConfig: { entityMessagePollInterval: 1000 } })),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(InteractionsLive),
  Layer.provideMerge(ChatTest.layer()),
  Layer.provideMerge(TablesLive),
  Layer.provideMerge(Layer.mergeAll(ScriptedModel, Agent.ConversationMode.layer(true))),
  Layer.provideMerge(Layer.mergeAll(SqliteClient.layer({ filename: DB }), NodeCrypto.layerDigest, NodeServices.layer, NodeHttpClient.layerUndici))
)
