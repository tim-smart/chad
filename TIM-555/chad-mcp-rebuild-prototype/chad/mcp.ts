// PROTOTYPE for "The MCP layer rebuild run with calls in flight" (TIM-555). Throwaway.
//
// The part of chad this ticket is about: the one wrapper round clanka's McpServers that every
// Agent is handed, and the one rebuild path (gate, drain, close, connect) from the seven rules on
// "Skills and MCP servers: where they live and how chad adds one" (TIM-537).
//
// What clanka fixes, read from 0.27.0 and seen in the runs:
//   - an Agent reads `prompt` and `dts` once, when it is built
//   - `handlers(onImage)` is called once per spawn: once for a turn, once for each sub-agent.
//     The keys it returns are the only MCP names that turn's scripts can reach.
//   - a server that failed to connect has no handlers at all
import { McpServers } from "clanka"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { log } from "./log.ts"
import * as Plugins from "./plugins.ts"

const env = process.env
/**
 * "written" runs the seven rules as the follow-up on TIM-537 has them. Anything else runs them as
 * amended on TIM-555 after the first run. A PROTO_MCP_* variable overrides either.
 */
export const WRITTEN = env.PROTO_MCP_RULES === "written"
/** Calls in flight into the old layer get this long. */
export const DRAIN_MS = Number(env.PROTO_MCP_DRAIN ?? 30_000)
/** The longest a call is held at the gate. */
export const HELD_MS = Number(env.PROTO_MCP_HELD ?? (WRITTEN ? 60_000 : 120_000))
/** The longest a turn that starts during a rebuild waits for the new layer. */
export const START_MS = Number(env.PROTO_MCP_START ?? 60_000)
/** How long the drain waits for an interrupted call to stop, as for plugins. */
const STOP_MS = Number(env.PROTO_MCP_STOP ?? 1_000)
/** Not in the rules. A pause between interrupting calls and closing the old layer, to see whether a cancellation then reaches an HTTP server. */
const PAUSE_MS = Number(env.PROTO_MCP_PAUSE ?? (WRITTEN ? 0 : 250))
/**
 * What a turn gets when it gave up waiting for the new layer.
 *   none      rule 6 as written: it "starts without MCP", so it has no handler keys
 *   fail      the previous layer's keys, each failing with the rule 6 message
 *   route     the previous layer's keys, treated like a turn that was already running
 */
const START_MODE = (env.PROTO_MCP_STARTMODE ?? (WRITTEN ? "none" : "route")) as "none" | "fail" | "route"

type Service = (typeof McpServers.McpServers)["Service"]
type Handlers = Record<string, (params: unknown) => Effect.Effect<unknown, string>>

interface Flight {
  readonly key: string
  readonly session: string
  readonly startedAt: number
  readonly done: Deferred.Deferred<void>
  fiber: Fiber.Fiber<any, any> | undefined
  cut: boolean
  stuck: boolean
  readonly cutNow: Deferred.Deferred<void>
}
interface Built {
  readonly n: number
  readonly why: string
  readonly service: Service
  readonly scope: Scope.Closeable
  /** mcp.json as written, and after ${NAME} was resolved. */
  readonly raw: string
  readonly resolved: string
  /** identifier -> configured name, for every server in mcp.json whether or not it connected. */
  readonly names: Map<string, string>
  readonly keys: ReadonlyArray<string>
  readonly inflight: Set<Flight>
  readonly handlers: WeakMap<object, Handlers>
  state: "open" | "closed"
}

let current: Built | undefined
/** What the last layer that was current offered. A turn or sub-agent that spawns while nothing is current gets these. */
let previous: { readonly keys: ReadonlyArray<string>; readonly prompt: string; readonly dts: string } = { keys: [], prompt: "", dts: "" }
let rebuilding: { readonly gate: Deferred.Deferred<void>; readonly label: string; readonly startedAt: number } | undefined
/** A graceful stop abandoned a rebuild after the old layer closed. */
let between = false
let builds = 0
/** Bumped when a new layer becomes current. A session rebuilds its Agent at its next turn when it is behind. */
export let generation = 0
/** Stands in for the secret store. */
export const secrets: Record<string, string> = {}
/** Sessions whose running turn gave up waiting for a rebuild when it started. */
const startedDuring = new Set<string>()
/** Amended: sessions whose running turn started at boot with no layer at all. Their prompt says so. */
const withoutMcp = new Set<string>()
export const startedWithout = (session: string) => !WRITTEN && withoutMcp.has(session)
export const STILL_STARTING = "MCP servers were still starting when this turn began. They are available from your next turn."
/** A layer has been current in this process. False from boot until the first one connects. */
let hadLayer = false
/** identifier -> configured name, for every server any layer has had. */
const everNames = new Map<string, string>()

// --- mcp.json ---------------------------------------------------------------------------------

const readRaw = (dir: string) => {
  const file = path.join(dir, "mcp.json")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}"
}
const liveDir = () => (fs.existsSync(Plugins.LIVE) ? path.join(Plugins.REPO, fs.readlinkSync(Plugins.LIVE)) : undefined)

/** ${NAME} and ${NAME:-default}, from the secret store and then the process env. A missing name makes the server unavailable. */
const expand = (value: unknown, missing: Array<string>): any => {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      const found = secrets[name] ?? env[name] ?? fallback
      if (found === undefined) missing.push(name)
      return found ?? ""
    })
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, missing))
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, missing)]))
  return value
}
const redact = (record: Record<string, string> | undefined) =>
  record === undefined ? undefined : Object.fromEntries(Object.entries(record).map(([k, v]) => [k, Redacted.make(v)]))
const timeouts = (entry: any) => ({
  ...(entry.connectTimeout === undefined ? {} : { connectTimeout: Duration.millis(entry.connectTimeout) }),
  ...(entry.callTimeout === undefined ? {} : { callTimeout: Duration.millis(entry.callTimeout) })
})
const resolve = (raw: string) => {
  const servers: Record<string, any> = JSON.parse(raw).mcpServers ?? {}
  const entries: Record<string, McpServers.ServerEntry> = {}
  const shown: Record<string, unknown> = {}
  for (const [name, written] of Object.entries(servers)) {
    const missing: Array<string> = []
    const entry = expand(written, missing)
    shown[name] = entry
    if (missing.length > 0) entries[name] = { type: "unavailable", error: "needs " + missing.join(", ") }
    else if (entry.url !== undefined) entries[name] = { type: "http", url: entry.url, ...(entry.headers ? { headers: redact(entry.headers)! } : {}), ...timeouts(entry) }
    else entries[name] = { type: "stdio", command: entry.command, args: entry.args ?? [], ...(entry.env ? { env: redact(entry.env)! } : {}), ...timeouts(entry) }
  }
  return { entries, resolved: JSON.stringify(shown) }
}
/** The names ${...} that mcp.json mentions. */
const named = (raw: string) => new Set([...raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))

// --- flights ----------------------------------------------------------------------------------

const fly = <A, E>(layer: Built, key: string, session: string, effect: Effect.Effect<A, E>) => {
  const flight: Flight = { key, session, startedAt: Date.now(), done: Deferred.makeUnsafe<void>(), fiber: undefined, cut: false, stuck: false, cutNow: Deferred.makeUnsafe<void>() }
  layer.inflight.add(flight)
  const fiber = Effect.runFork(effect)
  flight.fiber = fiber
  fiber.addObserver(() => {
    layer.inflight.delete(flight)
    Deferred.doneUnsafe(flight.done, Exit.void)
  })
  return Effect.raceFirst(
    Fiber.await(fiber) as Effect.Effect<Exit.Exit<A, E>>,
    Effect.as(Deferred.await(flight.cutNow), Exit.interrupt() as Exit.Exit<A, E>)
  ).pipe(
    Effect.onInterrupt(() => Fiber.interrupt(fiber)),
    Effect.map((exit) => ({ exit, flight }))
  )
}

// --- the messages -------------------------------------------------------------------------------

const CUT = (key: string) => "mcp." + key + (WRITTEN ? " was interrupted by an MCP restart, it may have partly run." : " was interrupted by an MCP restart. It may have run in part or in full.")
const STUCK = (key: string) => "mcp." + key + " did not stop when an MCP restart interrupted it and may still be running."
export const NOT_SENT = "MCP servers are restarting. This call was not sent."
export const STARTED_DURING = "MCP servers were restarting when this turn started. They are back in your next turn."
const REMOVED = (key: string) =>
  WRITTEN
    ? "mcp." + key + " was removed by an apply and is gone from your next turn."
    : "mcp." + key + ": MCP server \"" + (everNames.get(key.slice(0, key.indexOf("."))) ?? key.slice(0, key.indexOf("."))) + "\" was removed from mcp.json."
const firstLine = (text: string) => text.split("\n")[0]

/** Why the current layer has no handler for this key. */
const missing = (layer: Built, key: string): Effect.Effect<never, string> =>
  Effect.gen(function*() {
    if (key === "searchTools") return yield* Effect.fail("searchTools: no MCP server is connected.")
    const dot = key.indexOf(".")
    const name = layer.names.get(key.slice(0, dot))
    // Gone from mcp.json.
    if (name === undefined) return yield* Effect.fail(REMOVED(key))
    const status = (yield* layer.service.status)[name]
    // Still in mcp.json. clanka makes no handler for a server that did not connect, so there is no
    // error of clanka's to keep: chad words this one itself, from the status.
    if (status !== undefined && status._tag === "Failed") {
      return yield* Effect.fail("mcp." + key + ": MCP server \"" + name + "\" is not connected: " + firstLine(status.error))
    }
    // Connected, and it no longer lists the tool.
    if (!WRITTEN) return yield* Effect.fail("mcp." + key + ": \"" + name + "\" no longer lists this tool.")
    return yield* Effect.fail(layer.why.startsWith("apply") ? REMOVED(key) : "mcp." + key + ": \"" + name + "\" no longer lists this tool since the MCP servers restarted (" + layer.why + ").")
  })

// --- the wrapper every Agent is handed ---------------------------------------------------------

const handlersOf = (layer: Built, onImage: object): Handlers => {
  let h = layer.handlers.get(onImage)
  if (h === undefined) layer.handlers.set(onImage, h = layer.service.handlers(onImage as any) as Handlers)
  return h
}

/** Amended: what searchTools shows and this turn or sub-agent holds no key for. */
const hint = (layer: Built, own: ReadonlySet<string>, value: unknown) => {
  if (WRITTEN || typeof value !== "string") return value
  const extra = layer.keys.filter((k) => k !== "searchTools" && !own.has(k)).map((k) => "mcp." + k)
  if (extra.length === 0) return value
  return value + "\n\n" + extra.join(", ") + (extra.length === 1 ? " is" : " are") + " callable from your next turn."
}

const handler = (session: string, key: string, onImage: object, own: ReadonlySet<string>) => (params: unknown): Effect.Effect<unknown, string> =>
  Effect.suspend(() => {
    const arrived = Date.now()
    let held = false
    const refuse = (message: string, at: string) => {
      log("mcp.call.refused", { session, key, at, message })
      return Effect.fail(message)
    }
    const attempt = (): Effect.Effect<unknown, string> => {
      if (START_MODE === "fail" && startedDuring.has(session)) return refuse(STARTED_DURING, "turn started during a rebuild")
      if (rebuilding !== undefined) {
        if (!held) log("mcp.call.held", { session, key, rebuild: rebuilding.label })
        held = true
        return Deferred.await(rebuilding.gate).pipe(
          Effect.timeoutOption(Math.max(0, HELD_MS - (Date.now() - arrived))),
          Effect.flatMap((opened) => Option.isNone(opened) ? refuse(NOT_SENT, "held " + (Date.now() - arrived) + " ms") : Effect.suspend(attempt))
        )
      }
      if (held) log("mcp.call.released", { session, key, heldMs: Date.now() - arrived })
      const layer = current
      if (layer === undefined) {
        // A graceful stop abandoned the rebuild after the old layer closed. As for plugins: the call
        // is not answered, and the stop cuts its turn, which resumes after the restart.
        if (between) {
          log("mcp.call.heldForStop", { session, key })
          return Effect.never
        }
        return refuse("MCP servers are not running.", "no layer")
      }
      const call = handlersOf(layer, onImage)[key]
      if (call === undefined) return missing(layer, key).pipe(Effect.tapError((message) => Effect.sync(() => log("mcp.call.refused", { session, key, at: "not in layer " + layer.n, message }))))
      log("mcp.call.routed", { session, key, to: layer.n })
      return fly(layer, key, session, call(params)).pipe(
        Effect.flatMap(({ exit, flight }): Effect.Effect<unknown, string> => {
          if (Exit.isSuccess(exit)) return Effect.succeed(key === "searchTools" ? hint(layer, own, exit.value) : exit.value)
          if (flight.stuck) return Effect.fail(STUCK(key))
          if (flight.cut) return Effect.fail(CUT(key))
          const failure = Cause.squash(exit.cause)
          return Effect.fail(typeof failure === "string" ? failure : failure instanceof Error ? failure.message : JSON.stringify(failure))
        })
      )
    }
    return attempt()
  })

/**
 * What chad provides as clanka's McpServers when it builds a session's Agent. clanka reads
 * `prompt` and `dts` once per build, and calls `handlers` once per spawn.
 */
export const serviceFor = (session: string): Service => {
  const without = () => current === undefined && START_MODE === "none"
  return McpServers.McpServers.of({
    status: Effect.suspend(() => current === undefined ? Effect.succeed({}) : current.service.status),
    get prompt() {
      return current !== undefined ? current.service.prompt : without() ? "" : previous.prompt
    },
    get dts() {
      return current !== undefined ? current.service.dts : without() ? "" : previous.dts
    },
    handlers: (onImage) => {
      // During the drain the old layer is still current. Between its close and the new layer there is none.
      const keys = current !== undefined ? current.keys : without() ? [] : previous.keys
      log("mcp.keysTaken", { session, layer: current?.n ?? null, rebuilding: rebuilding?.label ?? null, keys })
      const own = new Set(keys)
      return Object.fromEntries(keys.map((key) => [key, handler(session, key, onImage, own)]))
    }
  } as Service)
}

/** A stamp of what an Agent was built against. It differs once a layer becomes current after the build. */
export const builtToken = () => generation + (current === undefined ? "-none" : "")
export const promptHash = () => crypto.createHash("sha256").update((current?.service.prompt ?? "") + "\n" + (current?.service.dts ?? "")).digest("hex").slice(0, 8)

/** A turn that starts during a rebuild waits for the new layer before its Agent is built and it takes its handler keys. */
export const awaitTurnStart = (session: string) =>
  Effect.suspend(() => {
    startedDuring.delete(session)
    withoutMcp.delete(session)
    if (rebuilding === undefined) return Effect.void
    const asWritten = WRITTEN || env.PROTO_MCP_START !== undefined
    // Amended: with a layer to fall back on the turn does not wait. It starts on that layer's keys
    // and prompt and is a running turn from then on.
    if (!asWritten && hadLayer) return Effect.sync(() => void log("mcp.turn.startsOnPrevious", { session, rebuild: rebuilding?.label }))
    // Amended: at boot there is nothing to fall back on, so it waits like a held call.
    const cap = asWritten ? START_MS : HELD_MS
    const started = Date.now()
    log("mcp.turn.waiting", { session, rebuild: rebuilding.label })
    return Deferred.await(rebuilding.gate).pipe(
      Effect.timeoutOption(cap),
      Effect.map((opened) => {
        if (Option.isNone(opened)) {
          startedDuring.add(session)
          if (!hadLayer) withoutMcp.add(session)
          log("mcp.turn.gaveUp", { session, ms: Date.now() - started, mode: START_MODE })
        } else log("mcp.turn.waited", { session, ms: Date.now() - started })
      })
    )
  })
export const turnEnded = (session: string) => {
  startedDuring.delete(session)
  withoutMcp.delete(session)
}

// --- the one rebuild path -----------------------------------------------------------------------

const connect = (why: string, raw: string) =>
  Effect.gen(function*() {
    const { entries, resolved } = resolve(raw)
    const scope = yield* Scope.make()
    const started = Date.now()
    const context = yield* Layer.buildWithScope(McpServers.layer(entries), scope).pipe(
      Effect.onInterrupt(() => Scope.close(scope, Exit.void))
    )
    const service = Context.get(context, McpServers.McpServers)
    const names = new Map<string, string>()
    for (const name of Object.keys(entries)) {
      const id = McpServers.identifier(name)
      if (!names.has(id)) names.set(id, name)
      everNames.set(id, name)
    }
    const layer: Built = {
      n: ++builds, why, service, scope, raw, resolved, names, keys: Object.keys(service.handlers(() => Effect.void)), inflight: new Set(), handlers: new WeakMap(), state: "open"
    }
    const status = yield* service.status
    log("mcp.connected", { layer: layer.n, why, ms: Date.now() - started, servers: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v._tag === "Connected" ? "connected, " + v.tools.length + " tools" : "failed: " + firstLine(v.error)])) })
    return layer
  })

const install = (layer: Built) => {
  current = layer
  previous = { keys: layer.keys, prompt: layer.service.prompt, dts: layer.service.dts }
  between = false
  hadLayer = true
  generation++
}

/** The gate closes here, in one synchronous step, so an apply can close it together with the plugin gates. */
const closeGate = (label: string) => {
  const gate = Deferred.makeUnsafe<void>()
  rebuilding = { gate, label, startedAt: Date.now() }
  log("mcp.gateClosed", { label, layer: current?.n ?? null, inflight: [...(current?.inflight ?? [])].map((f) => f.key + " in " + f.session) })
  return gate
}

const rebuild = (label: string, raw: string, gate: Deferred.Deferred<void>) =>
  Effect.gen(function*() {
    const started = rebuilding!.startedAt
    const old = current
    let interrupted: Array<string> = []
    if (old !== undefined) {
      // 1. One drain, one deadline.
      const flights = [...old.inflight]
      yield* Effect.forEach(flights, (f) => Deferred.await(f.done), { concurrency: "unbounded", discard: true }).pipe(Effect.timeoutOption(DRAIN_MS))
      const late = [...old.inflight]
      for (const f of late) {
        f.cut = true
        log("mcp.call.interrupted", { key: f.key, session: f.session, layer: old.n, ranMs: Date.now() - f.startedAt })
      }
      interrupted = late.map((f) => f.key + " in " + f.session)
      yield* Effect.forEach(late, (f) =>
        f.fiber === undefined ? Effect.void : Effect.suspend(() => {
          const asked = Date.now()
          return Fiber.interrupt(f.fiber!).pipe(
            Effect.timeoutOption(STOP_MS),
            Effect.map((done) => {
              if (Option.isNone(done)) f.stuck = true
              log("mcp.call.stopped", { key: f.key, session: f.session, stopped: Option.isSome(done), ms: Date.now() - asked })
              Deferred.doneUnsafe(f.cutNow, Exit.void)
            })
          )
        }), { concurrency: "unbounded", discard: true })
      log("mcp.drained", { label, ms: Date.now() - started, interrupted })
      if (PAUSE_MS > 0 && late.length > 0) yield* Effect.sleep(PAUSE_MS)
      // 2. The old layer closes. The rules give this no deadline.
      const closing = Date.now()
      old.state = "closed"
      yield* Scope.close(old.scope, Exit.void)
      current = undefined
      log("mcp.closed", { label, layer: old.n, ms: Date.now() - closing })
    }
    // 3. The new layer connects.
    const next = yield* connect(label, raw)
    install(next)
    rebuilding = undefined
    Deferred.doneUnsafe(gate, Exit.void)
    const result = { label, layer: next.n, generation, waitedMs: Date.now() - started, interrupted, runningTurns: [...Plugins.runningTurns.keys()] }
    log("mcp.ready", result)
    return result
  }).pipe(
    // A graceful stop abandons the rebuild wherever it is.
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        if (rebuilding === undefined) return
        const state = current !== undefined && current.state === "open" ? "the old layer stays for the graceful stop" : "the old layer is closed and no new one is connected"
        if (current !== undefined && current.state === "closed") current = undefined
        if (current === undefined) between = true
        rebuilding = undefined
        Deferred.doneUnsafe(gate, Exit.void)
        log("mcp.abandoned", { label, state })
      })
    )
  )

/** chad mcp restart, a finished chad mcp login, a changed secret: the config is what live holds. */
export const restart = (label: string) =>
  Plugins.queued(Effect.suspend(() => {
    const raw = readRaw(liveDir() ?? Plugins.WORK)
    return rebuild(label, raw, closeGate(label))
  }))

/** chad secret set. A rebuild follows only when mcp.json names the secret. */
export const setSecret = (name: string, value: string) =>
  Effect.suspend(() => {
    secrets[name] = value
    const raw = current?.raw ?? "{}"
    if (!named(raw).has(name)) return Effect.sync(() => void log("mcp.secretNotNamed", { name }))
    return Effect.asVoid(restart("secret " + name))
  })

/**
 * Called by an apply at its commit, before the plugin gates close. When mcp.json changed, the MCP
 * gate closes in the same synchronous step and the rebuild runs next to the plugin swap.
 */
Plugins.companion.atCommit = (dir: string) =>
  Effect.suspend(() => {
    const raw = readRaw(dir)
    if (current !== undefined && current.raw === raw) return Effect.succeed(undefined)
    if (current === undefined && raw === "{}" && !between) return Effect.succeed(undefined)
    const gate = closeGate("apply")
    return Effect.sync(() => Effect.runFork(rebuild("apply", raw, gate)))
  })

/**
 * A boot closes the gate at once and connects in the background, so the daemon is up before its
 * MCP servers are. A turn that arrives meanwhile is a turn that starts during a rebuild.
 */
export const boot = Effect.sync(() => {
  const dir = liveDir()
  if (dir === undefined) return
  const raw = readRaw(dir)
  if (raw === "{}") return
  const gate = closeGate("boot")
  Effect.runFork(Plugins.queued(rebuild("boot", raw, gate)))
})

export const closeAll = Effect.suspend(() => {
  const layer = current
  if (layer === undefined || layer.state === "closed") return Effect.void
  const started = Date.now()
  layer.state = "closed"
  return Scope.close(layer.scope, Exit.void).pipe(Effect.map(() => log("mcp.closed", { label: "graceful stop", layer: layer.n, ms: Date.now() - started })))
})

export const status = () =>
  Effect.gen(function*() {
    if (current === undefined) return { layer: null as number | null, rebuilding: rebuilding?.label ?? null, servers: {} }
    const s = yield* current.service.status
    return { layer: current.n as number | null, rebuilding: rebuilding?.label ?? null, servers: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v._tag === "Connected" ? "connected" : "failed: " + firstLine(v.error)])) }
  })
