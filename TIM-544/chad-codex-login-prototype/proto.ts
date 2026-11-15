// PROTOTYPE for "Codex login run for real" (TIM-544). Throwaway.
// A tiny host: clanka 0.27.0 on the openai provider through the Codex login,
// one CodexAuth for the process, chad's wrapper around it, chad's
// DeviceCodeHandler, and sessions that build their own model layer.
//
// Run: node proto.ts <scenario>     (see the switch at the bottom)
// Tokens: ./PROTOTYPE-wipe-me-auth (file KeyValueStore, mode 0700). Wipe it when done.
import { OpenAiClient } from "@effect/ai-openai"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Agent, AgentExecutor, Codex, Compaction, DeviceCodeHandler, GlobalWebSocket } from "clanka"
import { CodexAuth, CodexAuthError, type TokenData } from "clanka/CodexAuth"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const authDir = process.env.PROTO_AUTH_DIR ?? join(import.meta.dirname, "PROTOTYPE-wipe-me-auth")
mkdirSync(authDir, { recursive: true })
chmodSync(authDir, 0o700)
const modelName = process.env.PROTO_MODEL ?? "gpt-6-astra"
const effort = process.env.PROTO_EFFORT ?? "low"
// The user code is only printed in full for the run Tim logs in with.
const showCode = process.env.PROTO_SHOW_CODE === "1"

const t0 = Date.now()
const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s"
const log = (who: string, msg: string) => console.log("[" + secs() + "] " + who.padEnd(9) + " " + msg)

// --- What chad sets around a turn -------------------------------------------

interface SessionRef {
  readonly id: string
  /** False for a cron job's turn or one a plugin started with Turns.start. */
  readonly ownerPresent: boolean
}
class CurrentSession extends Context.Reference<SessionRef | undefined>("chad/CurrentSession", {
  defaultValue: () => undefined
}) {}

// --- chad's DeviceCodeHandler -----------------------------------------------

const codes: Array<{ readonly session: string | undefined; readonly code: string }> = []
let onCodeOut: ((session: string | undefined) => void) | undefined

const HandlerLive = Layer.succeed(DeviceCodeHandler.DeviceCodeHandler, {
  onCode: (options) =>
    Effect.gen(function*() {
      const session = yield* CurrentSession
      codes.push({ session: session?.id, code: options.deviceCode })
      const shown = showCode ? options.deviceCode : "****-***" + options.deviceCode.slice(-2)
      log("onCode", "code #" + codes.length + " issued. CurrentSession inside onCode: " +
        (session === undefined ? "(not set)" : session.id + ", ownerPresent " + session.ownerPresent))
      if (session !== undefined && !session.ownerPresent) {
        log("onCode", "no owner present, the handler dies")
        return yield* Effect.die(new Error("NoOwnerPresent"))
      }
      log("discord", "to " + (session?.id ?? "the owner notice channel") + ": Open " + options.verifyUrl + " and enter " + shown)
      onCodeOut?.(session?.id)
    })
})

// Counts the requests CodexAuth makes to auth.openai.com, by path. No bodies.
const authRequests: Record<string, number> = {}
const CountingHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, HttpClient.mapRequest((request) => {
    const path = new URL(request.url, "https://auth.openai.com").pathname
    authRequests[path] = (authRequests[path] ?? 0) + 1
    return request
  }))
).pipe(Layer.provide(NodeHttpClient.layerUndici))
// PROTO_DUMP=<dir> writes each model request body to a file. Bodies hold the
// prompt and no credentials. Only the HTTP transport sends whole requests here.
// PROTO_SESSION_HEADER=1 also sends the session id in the session_id and
// conversation_id headers, as the Codex CLI does. chad can do this in its own
// HttpClient layer with clanka unchanged. One session per process here.
let dumped = 0
const runNonce = randomBytes(4).toString("hex")
// "1" sends both, or name one of the two.
const headerNames = process.env.PROTO_SESSION_HEADER === "1" ? ["session_id", "conversation_id"] : (process.env.PROTO_SESSION_HEADER ?? "").split(",").filter((name) => name !== "")
const sessionHeader = headerNames.length > 0
const ModelHttp = process.env.PROTO_DUMP === undefined && !sessionHeader ? NodeHttpClient.layerUndici : Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, HttpClient.mapRequest((request) => {
    if (sessionHeader) {
      request = HttpClientRequest.setHeaders(request, Object.fromEntries(headerNames.map((name) => [name, "session-" + runNonce])))
    }
    if (process.env.PROTO_DUMP === undefined) return request
    const body = request.body as any
    if (body?._tag === "Uint8Array") {
      mkdirSync(process.env.PROTO_DUMP!, { recursive: true })
      writeFileSync(join(process.env.PROTO_DUMP!, "request-" + String(++dumped).padStart(2, "0") + ".json"), new TextDecoder().decode(body.body))
    }
    return request
  }))
).pipe(Layer.provide(NodeHttpClient.layerUndici))
const showAuthRequests = () =>
  Object.entries(authRequests).map(([path, n]) => path + " x" + n).join(", ") || "none"

// --- The host ---------------------------------------------------------------

interface HostOptions {
  /** chad's wrapper owns the wait. False runs on clanka's CodexAuth as it is. */
  readonly wrap: boolean
  readonly loginTimeout: Duration.Input
}

const makeHost = Effect.fnUntraced(function*(options: HostOptions) {
  const outer = yield* Effect.scope
  const inner = Context.get(
    yield* Layer.build(CodexAuth.layer.pipe(
      Layer.provide([HandlerLive, KeyValueStore.layerFileSystem(authDir), CountingHttp]),
      Layer.provide(NodeServices.layer)
    )),
    CodexAuth
  )
  const timedOut = () =>
    Effect.fail(new CodexAuthError({ reason: "DeviceFlowFailed", message: "Login timed out" }))

  // chad's wrapper. One wait for the whole process: the first caller starts
  // inner.get in a fiber the wrapper owns, everyone else awaits the same
  // Deferred. The timeout is on that one fiber, so a waiter never gets
  // clanka's lock after it and never starts a second device flow.
  let inflight: Deferred.Deferred<TokenData, CodexAuthError> | undefined
  let leader: string | undefined
  let codeOut = false
  const waiters = new Set<string>()
  onCodeOut = () => {
    codeOut = true
    for (const waiter of waiters) log("discord", "to " + waiter + ": -# Waiting for the login in " + leader)
  }
  const shared = (flow: Effect.Effect<TokenData, CodexAuthError>) =>
    Effect.gen(function*() {
      const me = (yield* CurrentSession)?.id ?? "(no session)"
      if (inflight !== undefined) {
        // The leader's own model call comes back here when clanka retries it.
        if (me !== leader) waiters.add(me)
        if (codeOut && me !== leader) log("discord", "to " + me + ": -# Waiting for the login in " + leader)
        return yield* Deferred.await(inflight).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(me))))
      }
      const deferred = inflight = yield* Deferred.make<TokenData, CodexAuthError>()
      leader = me
      yield* flow.pipe(
        Effect.timeoutOrElse({ duration: options.loginTimeout, orElse: timedOut }),
        Effect.onExit((exit) => {
          inflight = undefined
          if (codeOut) log("wrapper", "the shared wait ended: " + (Exit.isSuccess(exit) ? "logged in" : firstLine(exit.cause)))
          codeOut = false
          return Deferred.done(deferred, exit)
        }),
        Effect.forkIn(outer)
      )
      return yield* Deferred.await(deferred)
    })
  const auth = options.wrap
    ? CodexAuth.of({
      verifyUrl: inner.verifyUrl,
      get: shared(inner.get),
      authenticate: shared(inner.authenticate),
      logout: inner.logout
    })
    // clanka as it is. The timeout can only go around each caller.
    : CodexAuth.of({
      ...inner,
      get: inner.get.pipe(Effect.timeoutOrElse({ duration: options.loginTimeout, orElse: timedOut }))
    })

  // One OpenAiClient for the process, over the shared CodexAuth.
  const client = yield* Layer.build(
    OpenAiClient.layer({ apiUrl: "https://chatgpt.com/backend-api/codex" }).pipe(
      Layer.provide(CodexAuth.layerClientNoDeps),
      Layer.provide([Layer.succeed(CodexAuth, auth), ModelHttp])
    )
  )
  const scratch = mkdtempSync(join(tmpdir(), "chad-proto-544-"))
  const executor = yield* Layer.build(AgentExecutor.layerLocal({ directory: scratch }).pipe(Layer.provide([NodeServices.layer, NodeHttpClient.layerUndici])))

  const session = (id: string, more?: Partial<Session>): Session => ({
    ref: { id, ownerPresent: true },
    cacheKey: id,
    transport: "ws",
    model: modelName,
    live: undefined,
    frozenSystem: undefined,
    ...more
  })

  // The session's model layer and Agent. Built inside the turn, so
  // CurrentSession is set while the layer is built.
  const build = Effect.fnUntraced(function*(s: Session, keep?: Live) {
    const scope = yield* Scope.fork(outer)
    if (keep !== undefined) {
      const agent = yield* Agent.makeWith({ skills: [], instructions: Option.none() }).pipe(
        Effect.provideContext(executor),
        Scope.provide(scope)
      )
      return { agent, scope, models: keep.models, modelScope: keep.modelScope } satisfies Live
    }
    const modelScope = yield* Scope.fork(outer)
    const make = s.transport === "ws" ? Codex.modelWebSocket : Codex.model
    const main = (make(s.model, {
      reasoning: { effort },
      ...(s.cacheKey === undefined ? {} : { prompt_cache_key: s.cacheKey })
    } as any) as Layer.Layer<any, never, any>).pipe(
      Layer.provide([Layer.succeedContext(client), GlobalWebSocket.layerWebSocketConstructor])
    ) as Layer.Layer<any>
    const models = yield* Layer.buildWithScope(
      Layer.mergeAll(main, Agent.layerSubagentModel(main), Compaction.layerSummarizerModel(main)),
      modelScope
    )
    const agent = yield* Agent.makeWith({ skills: [], instructions: Option.none() }).pipe(
      Effect.provideContext(executor),
      Scope.provide(scope)
    )
    return { agent, scope, models, modelScope } satisfies Live
  })

  // The rebuild from "Applying a plugin change to a live session" (TIM-531).
  const rebuild = Effect.fnUntraced(function*(s: Session, keepModel = false) {
    const old = s.live!
    const next = yield* build(s, keepModel ? old : undefined).pipe(Effect.provideService(CurrentSession, s.ref))
    next.agent.history.current = old.agent.history.current
    next.agent.environment.current = old.agent.environment.current
    yield* Scope.close(old.scope, Exit.void)
    if (!keepModel) yield* Scope.close(old.modelScope, Exit.void)
    s.live = next
    log(s.ref.id, (keepModel ? "Agent rebuilt, model layer kept" : "Agent and model layer rebuilt") + ", history carried over, prompt_cache_key " + (s.cacheKey ?? "not sent (random)"))
  })

  interface TurnOptions {
    /** chad asks for a token before send. */
    readonly precheck?: boolean
    readonly turnTimeout?: Duration.Input
    /** Runs once, when the turn's first script starts. */
    readonly onFirstScript?: Effect.Effect<void>
  }
  const turn = (s: Session, text: string, turnOptions: TurnOptions = {}) =>
    Effect.gen(function*() {
      const started = Date.now()
      log(s.ref.id, "turn starts: " + text)
      if (turnOptions.precheck !== false) {
        const token = yield* Effect.exit(auth.get)
        if (Exit.isFailure(token)) {
          log("discord", "to " + s.ref.id + ": -# " + firstLine(token.cause))
          return log(s.ref.id, "turn ended before send, " + took(started))
        }
      }
      if (s.live === undefined) {
        const built = yield* Effect.exit(build(s))
        if (Exit.isFailure(built)) {
          return log(s.ref.id, "turn ended while its model layer was built, " + took(started) + ": " + firstLine(built.cause))
        }
        s.live = built.value
      }
      yield* Effect.provideContext(run(s, s.live, text, started, turnOptions), s.live.models)
    }).pipe(
      Effect.provideService(CurrentSession, s.ref),
      (effect) => turnOptions.turnTimeout === undefined ? effect : Effect.provideService(effect, Agent.TurnTimeout, Duration.fromInputUnsafe(turnOptions.turnTimeout)),
      Effect.scoped
    ) as Effect.Effect<void>

  const run = (s: Session, live: Live, text: string, started: number, turnOptions: TurnOptions) =>
    Effect.gen(function*() {
      let usage = { inputTokens: 0, cacheRead: 0 }
      const calls: Array<string> = []
      let retries = 0
      let inSubagent = false
      let scripts = 0
      const messagesBefore = live.agent.history.current.content.length
      const stream = yield* live.agent.send({
        prompt: text,
        system: (o) => (s.frozenSystem ??= "You are chad, Tim's personal assistant. Answer in one short sentence.\n\n" + o.toolInstructions)
      })
      const exit = yield* stream.pipe(
        Stream.runForEach((part) =>
          Effect.suspend(() => {
            if (part._tag === "ScriptStart" && !inSubagent && scripts++ === 0 && turnOptions.onFirstScript !== undefined) {
              return turnOptions.onFirstScript
            }
            if (part._tag === "Usage") {
              calls.push((inSubagent ? "sub-agent " : "") + (part.inputTokens - usage.inputTokens) + " in / " + (part.cacheRead - usage.cacheRead) + " cached")
              usage = part
            }
            if (part._tag === "ErrorRetry") {
              retries++
              log(s.ref.id, "clanka retries the model call (#" + retries + "): " + String((part.error as any).reason?.description ?? part.error.message).slice(0, 220))
            }
            if (part._tag === "SubagentStart") inSubagent = true
            if (part._tag === "SubagentComplete") inSubagent = false
            return Effect.void
          })
        ),
        Effect.as("(stream ended without an answer)"),
        Effect.catchTag("AgentFinished", (finished) => Effect.succeed(finished.summary)),
        Effect.exit
      )
      if (Exit.isSuccess(exit)) {
        log(s.ref.id, "answer: " + exit.value.trim().replace(/\s+/g, " ").slice(0, 160))
        log(s.ref.id, "tokens: input " + usage.inputTokens + ", cached " + usage.cacheRead + "; per model call: " + calls.join(", "))
      } else {
        log(s.ref.id, "turn failed, " + took(started) + ", model retries " + retries + ": " + firstLine(exit.cause, 400))
        log(s.ref.id, "history: " + messagesBefore + " messages before the turn, " + live.agent.history.current.content.length + " after it failed")
      }
    }) as Effect.Effect<void, never, any>

  return { inner, auth, session, build, rebuild, turn, scratch, systemSha: (s: Session) => createHash("sha256").update(s.frozenSystem ?? "").digest("hex").slice(0, 8) }
})

interface Live {
  readonly agent: Agent.Agent
  readonly scope: Scope.Closeable
  readonly models: Context.Context<any>
  readonly modelScope: Scope.Closeable
}
interface Session {
  ref: SessionRef
  /** undefined sends no key, so clanka picks a random one per model layer. */
  cacheKey: string | undefined
  transport: "ws" | "http"
  model: string
  live: Live | undefined
  frozenSystem: string | undefined
}

const took = (started: number) => "after " + ((Date.now() - started) / 1000).toFixed(1) + "s"
const firstLine = (cause: Cause.Cause<unknown>, max = 140) => {
  const kind = Cause.hasDies(cause) ? "defect" : Cause.hasInterrupts(cause) ? "interrupt" : "failure"
  const text = Cause.pretty(cause).split("\n").find((line) => line.trim() !== "") ?? ""
  return kind + ": " + text.replace(/^\s*(\w*Error: )?/, "").slice(0, max)
}
const section = (title: string) => console.log("\n=== " + title)
const summary = () => log("summary", "device codes issued: " + codes.length + "; auth.openai.com requests: " + showAuthRequests())

// --- Scenarios --------------------------------------------------------------

const scenarios: Record<string, Effect.Effect<void, unknown, Scope.Scope>> = {
  // No login needed. A handler that dies ends the turn at once.
  dies: Effect.gen(function*() {
    const host = yield* makeHost({ wrap: true, loginTimeout: "30 seconds" })
    section("no owner present, logged out, chad's token check before send")
    yield* host.turn(host.session("cron-job", { ref: { id: "cron-job", ownerPresent: false } }), "Run the morning summary.")
    section("no owner present, logged out, no check: the WebSocket model layer is built first")
    yield* host.turn(host.session("cron-ws", { ref: { id: "cron-ws", ownerPresent: false } }), "Run the morning summary.", { precheck: false })
    section("no owner present, logged out, no check, HTTP transport: the token is asked for inside the model call")
    yield* host.turn(host.session("cron-http", { ref: { id: "cron-http", ownerPresent: false }, transport: "http" }), "Run the morning summary.", { precheck: false })
    summary()
  }),

  // No login needed. Two sessions, one login, and nobody completes it.
  timeout: Effect.gen(function*() {
    for (const wrap of [true, false]) {
      section(wrap ? "chad's wrapper owns the wait, 25s timeout" : "clanka's CodexAuth as it is, 25s timeout around each caller")
      const before = codes.length
      const host = yield* makeHost({ wrap, loginTimeout: "25 seconds" })
      yield* Effect.all([
        host.turn(host.session("thread-A"), "hello from A"),
        Effect.delay(host.turn(host.session("thread-B"), "hello from B"), "8 seconds")
      ], { concurrency: "unbounded" })
      log("host", "both turns are over. Waiting 20s more to see whether anything else starts.")
      const polls = authRequests["/api/accounts/deviceauth/token"] ?? 0
      yield* Effect.sleep("20 seconds")
      log("summary", "device codes issued in this run: " + (codes.length - before) +
        "; polls in the 20s after the last turn ended: " + ((authRequests["/api/accounts/deviceauth/token"] ?? 0) - polls))
    }
  }),

  // No login needed. clanka's TurnTimeout against a login wait inside a model call.
  "turn-timeout": Effect.gen(function*() {
    for (const wrap of [true, false]) {
      section((wrap ? "chad's wrapper" : "clanka's CodexAuth as it is, MaxRetries cut from 20 to 5 so the run ends") + ": login needed inside a model call, TurnTimeout 8s, login timeout 30s")
      const before = codes.length
      const host = yield* makeHost({ wrap, loginTimeout: "30 seconds" })
      yield* host.turn(host.session("thread-A", { transport: "http" }), "hello", { precheck: false, turnTimeout: "8 seconds" }).pipe(
        wrap ? (effect) => effect : Effect.provideService(Agent.MaxRetries, 5)
      )
      log("summary", "device codes issued in this run: " + (codes.length - before))
    }
  }),

// Logged in. Cache reads across an Agent rebuild, and from a sub-agent.
  // PROTO_KEY=0 sends no prompt_cache_key, so clanka picks a random one per model layer.
  cache: Effect.gen(function*() {
    const host = yield* makeHost({ wrap: true, loginTimeout: "30 seconds" })
    const nonce = runNonce
    const transport = process.env.PROTO_TRANSPORT === "http" ? "http" as const : "ws" as const
    const s = host.session("session-" + nonce, { transport })
    if (process.env.PROTO_KEY === "0") s.cacheKey = undefined
    // Something long to read, different in every run, so a cache read beyond
    // the system prompt can only come from this run.
    writeFileSync(
      join(host.scratch, "notes.txt"),
      Array.from({ length: 260 }, (_, i) => "Note " + (i + 1) + " (" + nonce + "): on day " + (i + 1) + " the owner logged " + ((i * 37) % 91) + " km and " + ((i * 53) % 17) + " coffees.").join("\n")
    )
    const doRebuild = process.env.PROTO_REBUILD !== "0"
    const pause = Effect.sleep(Duration.seconds(Number(process.env.PROTO_PAUSE ?? "0")))
    const recall = (n: number) => "From the notes you already printed, how many km did note " + n + " log? Answer from memory, run no script."
    section("transport " + transport + ", prompt_cache_key " + (s.cacheKey ?? "not sent") + ", pause between turns " + (process.env.PROTO_PAUSE ?? "0") + "s" + (sessionHeader ? ", headers sent: " + headerNames.join(" and ") : ""))
    yield* host.turn(s, "Remember this codeword: PLATYPUS-" + nonce + ". Reply ok.")
    yield* host.turn(s, "Run exactly this script, then tell me how many coffees note 200 has: console.log(await readFile({ path: 'notes.txt' }))")
    yield* pause
    yield* host.turn(s, recall(10))
    yield* pause
    yield* host.turn(s, recall(20))
    log(s.ref.id, "system prompt " + host.systemSha(s))
    yield* pause
    if (doRebuild) {
      section("rebuild")
      yield* host.rebuild(s, process.env.PROTO_REBUILD === "agent")
    } else {
      section("no rebuild (control)")
    }
    yield* host.turn(s, recall(30))
    log(s.ref.id, "system prompt " + host.systemSha(s) + " (frozen)")
    yield* pause
    yield* host.turn(s, recall(40))
    section("sub-agents on the main model, one after the other")
    yield* host.turn(s, "Run exactly this script and tell me what it printed: const a = await subagent({ prompt: 'Reply with the single word pong.' }); const b = await subagent({ prompt: 'Reply with the single word ping.' }); console.log(a.output, b.output)")
    summary()
  }),

  // Logged in, on a copy of the token. logout on the shared CodexAuth during a turn.
  midturn: Effect.gen(function*() {
    const transport = process.env.PROTO_TRANSPORT === "http" ? "http" as const : "ws" as const
    const host = yield* makeHost({ wrap: true, loginTimeout: "40 seconds" })
    const s = host.session("thread-" + transport, { transport })
    const logout = Effect.andThen(host.auth.logout, Effect.sync(() => log("host", "logout called on the shared CodexAuth while the script runs")))
    const script = (ms: number) => "Run exactly this script and tell me what it printed: await sleep(" + ms + "); console.log('slept')"
    section(transport + ": a first turn, logged in")
    yield* host.turn(s, "Reply with the single word: one")
    if (transport === "http") {
      section("http: logout while a script runs, 40s login timeout")
      yield* host.turn(s, script(5000), { onFirstScript: logout })
    } else {
      section("ws: logout while a script runs, the socket stays open")
      yield* host.turn(s, script(5000), { onFirstScript: logout })
      section("ws: still logged out, a script outlasts the socket's 60s idle time, TurnTimeout 15s, 40s login timeout")
      yield* host.turn(s, script(70000), { precheck: false, turnTimeout: "15 seconds" })
    }
    section(transport + ": the next owner message, chad's token check before send")
    yield* host.turn(s, "Reply with the single word: two")
    summary()
    log("host", "token file in the store after the run: " + existsSync(join(authDir, "codex.auth%2Ftoken")))
  }),

  // PROTO_AUTH_DIR is empty. PROTO_TOKEN_SRC is the store Tim's login wrote.
  "second-process": Effect.gen(function*() {
    const file = "codex.auth%2Ftoken"
    section("daemon A starts logged out")
    const a = yield* makeHost({ wrap: true, loginTimeout: "30 seconds" })
    execFileSync("cp", [join(process.env.PROTO_TOKEN_SRC!, file), join(authDir, file)])
    log("host", "a second process (cp) wrote the token file into the store. In the store now: " + existsSync(join(authDir, file)))
    section("daemon A, a turn with no owner present")
    yield* a.turn(a.session("A-cron", { ref: { id: "A-cron", ownerPresent: false } }), "Reply with the single word: one")
    execFileSync("cp", [join(process.env.PROTO_TOKEN_SRC!, file), join(authDir, file)])
    section("daemon B starts on the same store")
    const b = yield* makeHost({ wrap: true, loginTimeout: "30 seconds" })
    const sb = b.session("B-thread")
    yield* b.turn(sb, "Reply with the single word: two")
    execFileSync("rm", [join(authDir, file)])
    log("host", "a second process (rm) removed the token file. In the store now: " + existsSync(join(authDir, file)))
    section("daemon B, after the file is gone")
    yield* b.turn(sb, "Reply with the single word: three")
    yield* b.turn(b.session("B-thread-2"), "Reply with the single word: four")
    summary()
  }),

  // Logged in. Which models a Codex login accepts.
  models: Effect.gen(function*() {
    const host = yield* makeHost({ wrap: true, loginTimeout: "30 seconds" })
    for (const model of (process.env.PROTO_MODELS ?? "gpt-6-astra,gpt-6.1-sol,gpt-6.1-terra,gpt-6-luna").split(",")) {
      for (const transport of ["ws", "http"] as const) {
        section(model + " at " + effort + ", " + transport)
        yield* host.turn(host.session(model + "-" + transport, { model, transport }), "Reply with the single word: ok").pipe(
          Effect.provideService(Agent.MaxRetries, 0),
          Effect.timeoutOrElse({ duration: "90 seconds", orElse: () => Effect.sync(() => log(model, "no result in 90s")) })
        )
      }
    }
    summary()
  }),

  // Tim logs in. Two sessions need the login at the same moment.
  login: Effect.gen(function*() {
    const host = yield* makeHost({ wrap: true, loginTimeout: "15 minutes" })
    section("two sessions need a login at the same moment, 15 minute timeout")
    yield* Effect.all([
      host.turn(host.session("thread-A"), "Reply with the single word: ready"),
      Effect.delay(host.turn(host.session("thread-B"), "Reply with the single word: steady"), "2 seconds")
    ], { concurrency: "unbounded" })
    summary()
    log("host", "token store: " + authDir)
  })
}

const name = process.argv[2] ?? ""
const scenario = scenarios[name]
if (scenario === undefined) {
  console.log("usage: node proto.ts <" + Object.keys(scenarios).join(" | ") + ">")
} else {
  console.log("scenario " + name + ", model " + modelName + "/" + effort + ", node " + process.version + ", clanka 0.27.0")
  scenario.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, Agent.ConversationMode.layer(true))),
    Effect.andThen(Effect.sync(() => process.exit(0))),
    NodeRuntime.runMain
  )
}
