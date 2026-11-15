// PROTOTYPE for "The plugin swap run with live sessions" (TIM-552). Throwaway.
//
// The part of chad this ticket is about: plugin versions, the wrapper round every plugin tool
// handler, the hook queue that belongs to a plugin's name, and the one swap path (gate, drain,
// close deadline, activation) from "What an apply does to a plugin's work in flight" (TIM-547).
//
// The loader is the one from "Runtime and plugin loading mechanism" (TIM-538): esbuild to one CJS
// file per plugin, run with vm.compileFunction, every package import answered by the host.
// What is left out because that ticket already ran it: git, the type-check, error path rewriting.
import { ToolkitRenderer } from "clanka/ToolkitRenderer"
import * as Toolkit from "effect/ai/Toolkit"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as esbuild from "esbuild"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import * as vm from "node:vm"
import { log } from "./log.ts"
import * as Plugin from "./Plugin.ts"

const env = process.env
export const REPO = env.PROTO_REPO ?? "repo"
export const WORK = path.join(REPO, "work")
export const VERSIONS = path.join(REPO, "versions")
export const LIVE = path.join(REPO, "live")
/** One deadline for everything in flight into the old versions: tool calls and hooks together. */
export const DRAIN_MS = Number(env.PROTO_DRAIN ?? 30_000)
/** Closing the old versions' scopes. */
export const CLOSE_MS = Number(env.PROTO_CLOSE ?? 10_000)
/** How long the drain waits for an interrupted call or hook to actually stop. It comes out of the close deadline. */
const STUBBORN_MS = Number(env.PROTO_STUBBORN ?? 1_000)
/** Default hook budgets from the plugin API ticket. */
export const BUDGET: Record<Plugin.HookKind, number> = { beforeTurn: 5_000, afterTurn: 30_000, Compacted: 10_000 }
/** Diagnostic only: route every call to the current version by tool name, the rule that was rejected. */
const ROUTE_ANY = env.PROTO_ROUTE_ANY === "1"
/** Diagnostic only: route without carrying the parameters across the two schemas, to show what that lets through. */
const NO_RECODE = env.PROTO_NO_RECODE === "1"
/** Widens the window between the builds and the commit, so a stop can land before the commit. */
const BUILD_DELAY = Number(env.PROTO_BUILD_DELAY ?? 0)

// --- what the daemon knows that a reload can change ------------------------------------------

export const globals = { timezone: "Pacific/Auckland", owners: ["owner-1"] as Array<string>, safe: false }

// --- versions and slots -----------------------------------------------------------------------

interface ToolEntry {
  /** The tool definition, for its schemas. */
  readonly tool: any
  readonly decl: string
  readonly handler: (params: any) => Effect.Effect<any, any>
}
interface HookEntry {
  readonly run: (payload: any) => Effect.Effect<any, any>
  readonly timeout: number | undefined
}
/** One thing running inside a version: a tool call or a hook. */
interface Flight {
  readonly kind: "tool" | "hook"
  readonly label: string
  readonly session: string | undefined
  readonly startedAt: number
  readonly done: Deferred.Deferred<void>
  fiber: Fiber.Fiber<any, any> | undefined
  /** Set by the drain when it interrupts this flight at the deadline. */
  cut: boolean
  /** Set when the flight was still running after the wait that follows the interruption. */
  stuck: boolean
  /** Done by the drain once it stops waiting for this flight. The caller is answered here if the handler has not stopped. */
  readonly cutNow: Deferred.Deferred<void>
}
export interface Version {
  readonly plugin: string
  readonly instance: number
  readonly hash: string
  readonly code: string
  readonly settings: string
  readonly scope: Scope.Closeable
  readonly activated: Deferred.Deferred<void>
  readonly toolkits: Array<any>
  readonly tools: Map<string, ToolEntry>
  readonly hooks: Map<Plugin.HookKind, HookEntry>
  readonly inflight: Set<Flight>
  state: "built" | "active" | "closed"
}
type Status = "loaded" | "removed" | "off" | "safe" | "between"
interface Job {
  readonly kind: Plugin.HookKind
  readonly payload: any
  readonly done: Deferred.Deferred<void>
}
interface Slot {
  readonly name: string
  current: Version | undefined
  status: Status
  /** Defined from the moment the gate closes until the activation. */
  swap: { readonly gate: Deferred.Deferred<void>; readonly incoming: Version | undefined; readonly becoming: Status } | undefined
  readonly jobs: Array<Job>
  working: boolean
  /** "running with the previous <reason>: <error>" */
  note: string | undefined
}

export const slots = new Map<string, Slot>()
const slot = (name: string): Slot => {
  let s = slots.get(name)
  if (s === undefined) {
    s = { name, current: undefined, status: "removed", swap: undefined, jobs: [], working: false, note: undefined }
    slots.set(name, s)
  }
  return s
}
/** Bumped by every activation. A session rebuilds its Agent at the start of its next turn when it is behind. */
export let generation = 0
let instances = 0
let pendingHooks = 0
/** Defined while any swap is between its gate closing and its activation. */
let swapping: { readonly gate: Deferred.Deferred<void>; readonly label: string } | undefined

/** Sessions with a turn running, and the bundle each plugin had when the turn's Agent was built. */
export const runningTurns = new Map<string, { readonly built: Map<string, string>; subagents: number }>()

const id = (v: Version) => v.plugin + "#" + v.instance + "@" + v.hash

// --- the loader (TIM-538) ---------------------------------------------------------------------

const hostRequire = createRequire(import.meta.url)
const pluginRequire = (name: string) => name === "chad" ? { Plugin } : hostRequire(name)

const discover = (dir: string) => {
  const plugins = path.join(dir, "plugins")
  if (!fs.existsSync(plugins)) return []
  return fs.readdirSync(plugins).filter((f) => f.endsWith(".ts")).sort().map((f) => ({ name: f.slice(0, -3), file: path.resolve(plugins, f) }))
}

const bundle = async (file: string, dir: string) => {
  const result = await esbuild.build({
    entryPoints: [file], absWorkingDir: path.resolve(dir), bundle: true, write: false, outdir: path.resolve(dir),
    format: "cjs", platform: "node", target: "node24", logLevel: "silent", packages: "external"
  })
  const code = result.outputFiles[0].text
  return { code, hash: crypto.createHash("sha256").update(code).digest("hex").slice(0, 8) }
}

const renderer = Effect.runSync(Effect.service(ToolkitRenderer).pipe(Effect.provide(ToolkitRenderer.layer)))
/** The declaration clanka puts in the system prompt for this one tool. */
export const declaration = (tool: any): string => renderer.render(Toolkit.make(tool) as any)

const settingsOf = (dir: string, name: string): { enabled: boolean; settings: Record<string, any> } => {
  const file = path.join(dir, "chad.json")
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
  const entry = all.plugins?.[name] ?? {}
  return { enabled: entry.enabled !== false, settings: entry.settings ?? {} }
}

/** Runs the bundle and builds the plugin's Layer in a scope of its own. Not activated. */
const build = (name: string, loaded: { code: string; hash: string }, settings: Record<string, any>) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const version: Version = {
      plugin: name, instance: ++instances, hash: loaded.hash, code: loaded.code, settings: JSON.stringify(settings), scope,
      activated: Deferred.makeUnsafe<void>(), toolkits: [], tools: new Map(), hooks: new Map(), inflight: new Set(), state: "built"
    }
    const services = Layer.mergeAll(
      Layer.succeed(Plugin.PluginContext, {
        name, instance: version.instance, hash: loaded.hash, settings, timezone: globals.timezone, owners: [...globals.owners],
        log: (ev: string, data: Record<string, unknown> = {}) => Effect.sync(() => log("plugin." + ev, { plugin: name, instance: version.instance, hash: loaded.hash, ...data }))
      }),
      Layer.succeed(Plugin.Registry, {
        activated: Deferred.await(version.activated),
        addToolkit: (toolkit: any, handlers: Record<string, any>) =>
          Effect.sync(() => {
            version.toolkits.push(toolkit)
            for (const [tool, definition] of Object.entries<any>(toolkit.tools)) {
              version.tools.set(tool, { tool: definition, decl: declaration(definition), handler: handlers[tool] })
            }
          }),
        addHook: (kind: Plugin.HookKind, run: (payload: any) => Effect.Effect<any, any>, timeout: number | undefined) =>
          Effect.sync(() => void version.hooks.set(kind, { run, timeout }))
      })
    )
    const exit = yield* Effect.exit(Effect.suspend(() => {
      const module = { exports: {} as any }
      vm.compileFunction(loaded.code, ["require", "module", "exports"], { filename: name + ".bundle.cjs" })(pluginRequire, module, module.exports)
      if (!Plugin.isPlugin(module.exports.default)) return Effect.die(new Error("the default export is not a Plugin"))
      return Layer.buildWithScope(Layer.provide(module.exports.default, services) as any, scope)
    }))
    if (Exit.isFailure(exit)) {
      yield* Scope.close(scope, Exit.void)
      const error = Cause.pretty(exit.cause).split("\n")[0]
      log("build.failed", { plugin: name, hash: loaded.hash, error })
      return { ok: false as const, error }
    }
    log("build.ok", { version: id(version), tools: [...version.tools.keys()], hooks: [...version.hooks.keys()] })
    return { ok: true as const, version }
  })

/** Closes a version's scope under the close deadline. Past it the finalizers are abandoned. */
const close = (version: Version, why: string, budget = CLOSE_MS) =>
  Effect.gen(function*() {
    version.state = "closed"
    const started = Date.now()
    const fiber = Effect.runFork(Scope.close(version.scope, Exit.void))
    const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(budget))
    if (Option.isNone(exit)) {
      // Not interrupted: a finalizer runs uninterruptibly, so all chad can do is stop waiting for it.
      log("close.abandoned", { version: id(version), why, ms: Date.now() - started })
      return false
    }
    log("close.done", { version: id(version), why, ms: Date.now() - started })
    return true
  })

// --- flights ----------------------------------------------------------------------------------

/**
 * Registers the flight and starts it in one synchronous step, so the drain can never miss one,
 * then waits for it. The effect runs on a fiber of its own, which is what the drain interrupts.
 */
const fly = <A, E>(version: Version, kind: Flight["kind"], label: string, session: string | undefined, effect: Effect.Effect<A, E>) => {
  const flight: Flight = { kind, label, session, startedAt: Date.now(), done: Deferred.makeUnsafe<void>(), fiber: undefined, cut: false, stuck: false, cutNow: Deferred.makeUnsafe<void>() }
  version.inflight.add(flight)
  const fiber = Effect.runFork(effect)
  flight.fiber = fiber
  fiber.addObserver(() => {
    version.inflight.delete(flight)
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

// --- the wrapper round every plugin tool handler ----------------------------------------------

/** clanka keeps a turn open while a sub-agent runs, and a message sent meanwhile is steered into it, not into a new turn. */
const nextTurn = (session: string) =>
  (runningTurns.get(session)?.subagents ?? 0) > 0
    ? "your next turn, which cannot start while this turn has a sub-agent running."
    : "your next turn."
const changed = (tool: string, session: string) => tool + " was changed by an apply. The new version is in " + nextTurn(session)
const removed = (tool: string) => tool + " was removed by an apply and is gone from your next turn."
const safeOff = (tool: string) => tool + " is off in safe mode."
const cutMessage = (tool: string) => tool + " was interrupted by an apply, it may have partly run."
const stuckMessage = (tool: string) => tool + " did not stop when an apply interrupted it and may still be running."
const issue = (error: unknown) => String((error as any)?.message ?? error).split("\n").slice(0, 3).join(" ").slice(0, 300)

/**
 * What chad hands clanka as the handler of one plugin tool when it builds a session's Agent.
 * It closes over what the Agent was built with: the plugin's bundle hash and the tool's rendered
 * declaration. The plugin's current version is looked up when a call is made.
 */
export const wrapper = (session: string, plugin: string, tool: string, built: { readonly hash: string; readonly decl: string; readonly instance: number; readonly tool: any }) =>
(params: any): Effect.Effect<any, string> =>
  Effect.suspend(function attempt(): Effect.Effect<any, string> {
    const s = slot(plugin)
    const refuse = (message: string, at: string) => {
      log("call.refused", { session, tool, at, built: built.hash, current: s.current ? id(s.current) : s.status, message })
      return Effect.fail(message)
    }
    const gone = (status: Status) => status === "safe" ? safeOff(tool) : removed(tool)
    if (s.swap !== undefined) {
      const incoming = s.swap.incoming
      // Held only when the call could be routed after the activation.
      if (ROUTE_ANY ? incoming !== undefined : incoming !== undefined && incoming.hash === built.hash) {
        const started = Date.now()
        log("call.held", { session, tool, built: built.hash })
        return Deferred.await(s.swap.gate).pipe(
          Effect.andThen(Effect.sync(() => log("call.released", { session, tool, heldMs: Date.now() - started }))),
          Effect.andThen(Effect.suspend(attempt))
        )
      }
      return refuse(incoming === undefined ? gone(s.swap.becoming) : incoming.tools.has(tool) ? changed(tool, session) : removed(tool), "closed gate")
    }
    const current = s.current
    if (current === undefined && s.status === "between") {
      // A graceful stop abandoned the swap after the old version closed. Nothing can answer, and
      // "removed" would be a lie: the call waits for the stop to cut its turn, which resumes after the restart.
      log("call.heldForStop", { session, tool, built: built.hash })
      return Effect.never
    }
    if (current === undefined) return refuse(gone(s.status), "no version")
    const entry = current.tools.get(tool)
    if (!ROUTE_ANY) {
      if (current.hash !== built.hash) return refuse(entry === undefined ? removed(tool) : changed(tool, session), "bundle hash")
      if (entry === undefined) return refuse(removed(tool), "declaration")
      if (entry.decl !== built.decl) return refuse(changed(tool, session), "declaration")
    } else if (entry === undefined) return refuse(removed(tool), "no such tool")
    // The Agent's schemas decoded these parameters and will encode the result. When another instance
    // answers, both are carried across: encoded with one side's schema, decoded with the other's.
    // Same code, so the schemas only differ where the plugin built one from a setting.
    const recode = !ROUTE_ANY && !NO_RECODE && current.instance !== built.instance
    const input: Effect.Effect<any, string> = !recode ? Effect.succeed(params) : Schema.encodeUnknownEffect(built.tool.parametersSchema)(params).pipe(
      Effect.flatMap((encoded) => Schema.decodeUnknownEffect(entry.tool.parametersSchema)(encoded)),
      Effect.mapError((error) => {
        const message = tool + ": the parameters do not fit the version an apply loaded. " + issue(error)
        log("call.refused", { session, tool, at: "parameters", built: built.hash, current: id(current), message })
        return message
      })
    )
    return input.pipe(Effect.flatMap((decoded) => {
      log("call.routed", { session, tool, built: built.hash, to: id(current), recoded: recode })
      return fly(current, "tool", tool, session, entry.handler(decoded)).pipe(
        Effect.flatMap(({ exit, flight }): Effect.Effect<any, string> => {
          if (Exit.isSuccess(exit)) {
            if (!recode) return Effect.succeed(exit.value)
            return Schema.encodeUnknownEffect(entry.tool.successSchema)(exit.value).pipe(
              Effect.flatMap((encoded) => Schema.decodeUnknownEffect(built.tool.successSchema)(encoded)),
              // The call has run by now, so the message says so.
              Effect.mapError((error) => {
                const message = tool + " ran, but its result does not fit the declaration this turn was built with. " + issue(error)
                log("call.resultRefused", { session, tool, built: built.hash, on: id(current), message })
                return message
              })
            )
          }
          if (flight.stuck) return Effect.fail(stuckMessage(tool))
          if (flight.cut) return Effect.fail(cutMessage(tool))
          const failure = Cause.squash(exit.cause)
          return Effect.fail(typeof failure === "string" ? failure : failure instanceof Error ? failure.message : JSON.stringify(failure))
        })
      )
    }))
  })

// --- hooks ------------------------------------------------------------------------------------

/** A hook on the reply path (beforeTurn). It runs in the current version and counts as in flight. */
export const runHook = (plugin: string, kind: Plugin.HookKind, payload: any) =>
  Effect.suspend(() => {
    const s = slot(plugin)
    const current = s.current
    const hook = current?.hooks.get(kind)
    if (current === undefined || hook === undefined || s.swap !== undefined) return Effect.succeed(Option.none<any>())
    const started = Date.now()
    return fly(current, "hook", kind, payload?.session, hook.run(payload).pipe(Effect.timeoutOption(hook.timeout ?? BUDGET[kind]))).pipe(
      Effect.map(({ exit, flight }) => {
        const result = flight.stuck ? "did not stop when a swap interrupted it" : flight.cut ? "interrupted by a swap" : Exit.isFailure(exit) ? "failed" : Option.isNone(exit.value) ? "timeout" : "ok"
        log("hook.done", { plugin, kind, on: id(current), result, ms: Date.now() - started })
        return Exit.isSuccess(exit) ? exit.value : Option.none<any>()
      })
    )
  })

/**
 * Hooks off the reply path (afterTurn, Compacted). The queue belongs to the plugin's name: a job
 * holds the kind and the payload, and the version that runs it is looked up when its turn comes.
 */
export const enqueueHook = (plugin: string, kind: Plugin.HookKind, payload: any): Deferred.Deferred<void> => {
  const s = slot(plugin)
  const job: Job = { kind, payload, done: Deferred.makeUnsafe<void>() }
  s.jobs.push(job)
  pendingHooks++
  log("hook.queued", { plugin, kind, turn: payload?.turn, queued: s.jobs.length })
  if (!s.working) {
    s.working = true
    Effect.runFork(work(s))
  }
  return job.done
}

const finishJob = (job: Job) => {
  pendingHooks--
  Deferred.doneUnsafe(job.done, Exit.void)
}

const work = (s: Slot): Effect.Effect<void> =>
  Effect.suspend(() => {
    // A queued hook waits for the activation. The one that is already running is the drain's business.
    if (s.swap !== undefined) return Effect.andThen(Deferred.await(s.swap.gate), work(s))
    const job = s.jobs.shift()
    if (job === undefined) {
      s.working = false
      return Effect.void
    }
    const current = s.current
    const hook = current?.hooks.get(job.kind)
    if (current === undefined || hook === undefined) {
      log("hook.dropped", { plugin: s.name, kind: job.kind, turn: job.payload?.turn, why: current === undefined ? "the plugin is " + s.status : "the current version registers no " + job.kind + " hook", current: current ? id(current) : null })
      finishJob(job)
      return work(s)
    }
    const started = Date.now()
    return fly(current, "hook", job.kind, job.payload?.session, hook.run(job.payload).pipe(Effect.timeoutOption(hook.timeout ?? BUDGET[job.kind]))).pipe(
      Effect.flatMap(({ exit, flight }) => {
        const result = flight.stuck ? "did not stop when a swap interrupted it" : flight.cut ? "interrupted by a swap" : Exit.isFailure(exit) ? "failed" : Option.isNone(exit.value) ? "timeout" : "ok"
        log("hook.done", { plugin: s.name, kind: job.kind, turn: job.payload?.turn, on: id(current), result, ms: Date.now() - started })
        finishJob(job)
        return work(s)
      })
    )
  })

const dropQueued = (s: Slot, why: string) => {
  for (const job of s.jobs.splice(0)) {
    log("hook.dropped", { plugin: s.name, kind: job.kind, turn: job.payload?.turn, why })
    finishJob(job)
  }
}

/** A graceful stop runs what is queued, each inside its budget, before the plugins' scopes close. */
export const drainHooks = Effect.gen(function*() {
  log("hooks.draining", { pending: pendingHooks })
  while (pendingHooks > 0) yield* Effect.sleep(20)
  log("hooks.drained")
})

// --- what a turn and a timer wait on ----------------------------------------------------------

/** A turn that starts during a swap waits for the activation before it builds its Agent. */
export const awaitNoSwap: Effect.Effect<void> = Effect.suspend(() =>
  swapping === undefined ? Effect.void : Effect.andThen(Deferred.await(swapping.gate), awaitNoSwap)
)
export const isSwapping = () => swapping !== undefined

/** A timer is held while its plugin is mid-swap, and while the plugin is not loaded at all. */
export const awaitUsable = (plugin: string): Effect.Effect<"ready" | "held for a swap" | "held, not loaded"> =>
  Effect.gen(function*() {
    let held: "ready" | "held for a swap" | "held, not loaded" = "ready"
    while (true) {
      const s = slot(plugin)
      if (s.swap !== undefined) {
        if (held === "ready") held = "held for a swap"
        yield* Deferred.await(s.swap.gate)
        continue
      }
      if (s.current === undefined) {
        held = "held, not loaded"
        yield* Effect.sleep(25)
        continue
      }
      return held
    }
  })

// --- the one swap path ------------------------------------------------------------------------

interface Change {
  readonly plugin: string
  readonly next: Version | undefined
  readonly status: Status
}

/** Everything that changes what is loaded goes through here, one at a time. */
const queue = Semaphore.makeUnsafe(1)
let swapFiber: Fiber.Fiber<any, any> | undefined

const swap = (label: string, changes: ReadonlyArray<Change>) =>
  Effect.gen(function*() {
    const started = Date.now()
    const gate = Deferred.makeUnsafe<void>()
    const olds: Array<Version> = []
    // 1. Every gate closes.
    swapping = { gate, label }
    for (const change of changes) {
      const s = slot(change.plugin)
      s.swap = { gate, incoming: change.next, becoming: change.status }
      if (s.current !== undefined) olds.push(s.current)
    }
    log("swap.gateClosed", { label, plugins: changes.map((c) => c.plugin + ": " + (slot(c.plugin).current ? id(slot(c.plugin).current!) : "nothing") + " -> " + (c.next ? id(c.next) : c.status)) })

    const finish = (abandoned: boolean) => {
      for (const change of changes) slot(change.plugin).swap = undefined
      swapping = undefined
      Deferred.doneUnsafe(gate, Exit.void)
      return abandoned
    }

    // 2. One drain, one deadline, for the tool calls and hooks in flight into the old versions.
    const flights = olds.flatMap((v) => [...v.inflight])
    log("swap.draining", { label, inflight: flights.map((f) => f.kind + ":" + f.label + (f.session ? " in " + f.session : "")) })
    yield* Effect.forEach(flights, (f) => Deferred.await(f.done), { concurrency: "unbounded", discard: true }).pipe(Effect.timeoutOption(DRAIN_MS))
    const late = olds.flatMap((v) => [...v.inflight].map((f) => ({ f, v })))
    const interrupted: Array<string> = []
    for (const { f, v } of late) {
      f.cut = true
      interrupted.push(f.kind + ":" + f.label + (f.session ? " in " + f.session : ""))
      log(f.kind === "tool" ? "call.interruptedBySwap" : "hook.interruptedBySwap", { label: f.label, session: f.session, on: id(v), ranMs: Date.now() - f.startedAt })
    }
    // Interruption is asked for, and waited on for a moment only. A handler in an uninterruptible
    // region keeps running on a version that is about to close; its caller has already been answered.
    const stopStarted = Date.now()
    yield* Effect.forEach(late, ({ f, v }) =>
      f.fiber === undefined ? Effect.void : Fiber.interrupt(f.fiber).pipe(
        Effect.timeoutOption(STUBBORN_MS),
        Effect.map((done) => {
          if (Option.isNone(done)) {
            f.stuck = true
            log("flight.ignoredInterrupt", {
              kind: f.kind, label: f.label, session: f.session, on: id(v),
              note: f.kind === "tool" ? "two versions of " + v.plugin + " now overlap" : v.plugin + "'s hook queue moves on to the new version while this hook is still running"
            })
            f.fiber!.addObserver(() => log("flight.endedAfterAbandon", { kind: f.kind, label: f.label, on: id(v), ranMs: Date.now() - f.startedAt }))
          }
          // The caller is answered now, and told which of the two happened.
          Deferred.doneUnsafe(f.cutNow, Exit.void)
        })
      ), { concurrency: "unbounded", discard: true })
    // That wait comes out of the close deadline, so the two deadlines still add up to 40 seconds.
    const closeBudget = Math.max(0, CLOSE_MS - (Date.now() - stopStarted))
    const drainedMs = Date.now() - started
    log("swap.drained", { label, ms: drainedMs, interrupted })

    // 3. The old scopes close, under their own deadline.
    const closeStarted = Date.now()
    yield* Effect.forEach(olds, (v) => close(v, label, closeBudget), { concurrency: "unbounded", discard: true })

    // 4. The new versions activate together and the gates open.
    const affected: Array<string> = []
    for (const [session, turn] of runningTurns) {
      const lost = changes.filter((c) => turn.built.has(c.plugin) && turn.built.get(c.plugin) !== c.next?.hash).map((c) => c.plugin)
      if (lost.length > 0) affected.push(session + " loses " + lost.join(", ") + " until its turn ends (" + turn.subagents + " sub-agents running)")
    }
    for (const change of changes) {
      const s = slot(change.plugin)
      s.current = change.next
      s.status = change.status
      if (change.next !== undefined) {
        change.next.state = "active"
        s.note = undefined
        Deferred.doneUnsafe(change.next.activated, Exit.void)
      } else {
        s.note = undefined
        dropQueued(s, "the plugin is " + change.status)
      }
    }
    generation++
    finish(false)
    const result = { label, generation, waitedMs: Date.now() - started, drainedMs, closeMs: Date.now() - closeStarted, interrupted, affected }
    log("swap.activated", { ...result, now: changes.map((c) => c.plugin + ": " + (c.next ? id(c.next) : c.status)) })
    return result
  }).pipe(
    // A graceful stop abandons the swap wherever it is.
    Effect.onInterrupt(() =>
      Effect.gen(function*() {
        const report: Array<string> = []
        for (const change of changes) {
          const s = slot(change.plugin)
          if (s.swap === undefined) continue // already activated
          const old = s.current
          if (old !== undefined && old.state === "closed") {
            // Between its close and its activation: nothing of this plugin is left to run a hook.
            s.current = undefined
            s.status = "between"
            dropQueued(s, "the plugin is between its close and its activation")
            report.push(change.plugin + ": old version closed, new one never activated")
          } else report.push(change.plugin + ": stays on " + (old ? id(old) : "nothing") + " for the graceful stop")
          if (change.next !== undefined) yield* close(change.next, "abandoned before its activation")
          s.swap = undefined
        }
        const open = swapping
        swapping = undefined
        if (open !== undefined) Deferred.doneUnsafe(open.gate, Exit.void)
        log("swap.abandoned", { label, report })
      })
    )
  )

/**
 * TIM-555: what else an apply starts at its commit. chad/mcp.ts sets this. It closes the MCP gate
 * synchronously and returns the fiber of the rebuild, or undefined when mcp.json did not change.
 */
export const companion: { atCommit?: (dir: string) => Effect.Effect<Fiber.Fiber<any, any> | undefined> } = {}

/** Runs one queued change on a fiber of its own, so a stop can abandon it. */
export const queued = <A>(effect: Effect.Effect<A>): Effect.Effect<A> =>
  queue.withPermit(Effect.suspend(() => {
    const fiber = Effect.runFork(effect)
    swapFiber = fiber
    return Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)), Effect.ensuring(Effect.sync(() => void (swapFiber = undefined))))
  }))

/** Called first on a graceful stop, before anything waits for requests in flight. */
export const abandon = Effect.suspend(() => {
  log("stop.abandonSwap", { running: swapFiber !== undefined, swapping: swapping?.label ?? null })
  return swapFiber === undefined ? Effect.void : Fiber.interrupt(swapFiber)
})

const moveLive = (dir: string) => {
  const tmp = LIVE + ".next"
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(path.relative(REPO, dir), tmp)
  fs.renameSync(tmp, LIVE)
}

let snapshots = 0
/** Stands in for the git snapshot: a copy of work/ into versions/. */
const snapshot = () => {
  const dir = path.join(VERSIONS, Date.now() + "-" + process.pid + "-" + ++snapshots)
  fs.cpSync(WORK, dir, { recursive: true })
  return dir
}

export interface ApplyResult {
  readonly ok: boolean
  readonly exit: number
  readonly errors: ReadonlyArray<string>
  readonly reloaded: ReadonlyArray<string>
  readonly kept: ReadonlyArray<string>
  readonly swap?: { readonly waitedMs: number; readonly interrupted: ReadonlyArray<string>; readonly affected: ReadonlyArray<string> } | undefined
  readonly mcp?: unknown
}

/**
 * chad apply: build every changed plugin, and only then swap. One failed build means nothing swaps.
 * A plugin is "changed" when its bundle hash or its settings differ from the running version.
 */
export const apply: Effect.Effect<ApplyResult> = queued(Effect.gen(function*() {
  const dir = snapshot()
  const errors: Array<string> = []
  const changes: Array<Change> = []
  const kept: Array<string> = []
  const built: Array<Version> = []
  const seen = new Set<string>()
  const failed = (): ApplyResult => ({ ok: false, exit: 1, errors, reloaded: [], kept: [] })
  log("apply.start", { dir })
  const body = Effect.gen(function*() {
    for (const { name, file } of discover(dir)) {
      seen.add(name)
      const s = slot(name)
      const { enabled, settings } = settingsOf(dir, name)
      if (!enabled) {
        if (s.current !== undefined) changes.push({ plugin: name, next: undefined, status: "off" })
        else s.status = "off"
        continue
      }
      const loaded = yield* Effect.exit(Effect.promise(() => bundle(file, dir)))
      if (Exit.isFailure(loaded)) {
        errors.push(name + ": could not be bundled")
        continue
      }
      if (s.current !== undefined && s.current.hash === loaded.value.hash && s.current.settings === JSON.stringify(settings)) {
        kept.push(name)
        continue
      }
      const result = yield* build(name, loaded.value, settings)
      if (!result.ok) errors.push(name + ": " + result.error)
      else {
        built.push(result.version)
        changes.push({ plugin: name, next: result.version, status: "loaded" })
      }
    }
    for (const s of slots.values()) {
      if (s.current !== undefined && !seen.has(s.name)) changes.push({ plugin: s.name, next: undefined, status: "removed" })
    }
    if (errors.length > 0) {
      for (const v of built) yield* close(v, "another build in this apply failed")
      fs.rmSync(dir, { recursive: true, force: true })
      log("apply.refused", { errors })
      return failed()
    }
    if (BUILD_DELAY > 0) {
      log("apply.built", { waitingMs: BUILD_DELAY })
      yield* Effect.sleep(BUILD_DELAY)
    }
    return undefined
  }).pipe(
    // Cancelled before its commit: nothing changes.
    Effect.onInterrupt(() =>
      Effect.gen(function*() {
        for (const v of built) yield* close(v, "the apply was cancelled before its commit")
        fs.rmSync(dir, { recursive: true, force: true })
        log("apply.cancelledBeforeCommit", { live: fs.existsSync(LIVE) ? fs.readlinkSync(LIVE) : null })
      })
    )
  )
  const refused = yield* body
  if (refused !== undefined) return refused
  // The commit. From here on the apply finishes, or a stop abandons the swap and the next boot loads this.
  moveLive(dir)
  log("live.moved", { live: fs.readlinkSync(LIVE) })
  // TIM-555: the MCP gate closes here and the plugin gates close in swap's first synchronous step,
  // with nothing in between that yields. The two then run side by side.
  const side = companion.atCommit === undefined ? undefined : yield* companion.atCommit(dir)
  const result = yield* swap("apply", changes).pipe(Effect.onInterrupt(() => side === undefined ? Effect.void : Fiber.interrupt(side)))
  log("apply.pluginsActivated", { mcpStillRebuilding: side !== undefined && side.pollUnsafe() === undefined })
  // The command returns once the MCP servers have connected or failed, so it can report them.
  const mcp = side === undefined ? undefined : yield* Fiber.join(side).pipe(Effect.onInterrupt(() => Fiber.interrupt(side)))
  return { ok: true, exit: 0, errors: [], reloaded: changes.map((c) => c.plugin), kept, swap: result, mcp }
}))

/**
 * Every reload that is not an apply: chad plugin reload, a secret, owner or timezone change.
 * The code is the same, so each new version is built from the running version's bundle.
 * The ones that build swap. One that fails keeps its old version, except when an owner was removed.
 */
export const reload = (options: { readonly names?: ReadonlyArray<string>; readonly reason: string; readonly ownerRemoved?: boolean }): Effect.Effect<ApplyResult> =>
  queued(Effect.gen(function*() {
    const names = options.names ?? [...slots.values()].filter((s) => s.current !== undefined).map((s) => s.name)
    const changes: Array<Change> = []
    const errors: Array<string> = []
    log("reload.start", { reason: options.reason, names })
    for (const name of names) {
      const s = slot(name)
      const current = s.current
      if (current === undefined) continue
      const result = yield* build(name, { code: current.code, hash: current.hash }, JSON.parse(current.settings))
      if (result.ok) changes.push({ plugin: name, next: result.version, status: "loaded" })
      else {
        errors.push(name + ": " + result.error)
        if (options.ownerRemoved) changes.push({ plugin: name, next: undefined, status: "removed" })
        else s.note = "running with the previous " + options.reason + ": " + result.error
      }
    }
    const result = changes.length > 0 ? yield* swap("reload: " + options.reason, changes) : undefined
    const out: ApplyResult = { ok: errors.length === 0, exit: errors.length === 0 ? 0 : 1, errors, reloaded: changes.filter((c) => c.next !== undefined).map((c) => c.plugin), kept: [], swap: result }
    log("reload.done", { reason: options.reason, exit: out.exit, errors, reloaded: out.reloaded })
    return out
  }))

/** chad safe on: a swap to nothing. chad safe off: loads live the way a boot does. */
export const safe = (on: boolean): Effect.Effect<unknown> =>
  on
    ? queued(Effect.gen(function*() {
      globals.safe = true
      const changes = [...slots.values()].filter((s) => s.current !== undefined).map((s): Change => ({ plugin: s.name, next: undefined, status: "safe" }))
      return yield* swap("safe on", changes)
    }))
    : Effect.suspend(() => {
      globals.safe = false
      return boot
    })

/** A boot loads what live points at, skipping a plugin that fails to build. */
export const boot: Effect.Effect<void> = queued(Effect.gen(function*() {
  if (!fs.existsSync(LIVE)) return void log("boot.nothingApplied")
  const dir = path.join(REPO, fs.readlinkSync(LIVE))
  const changes: Array<Change> = []
  for (const { name, file } of discover(dir)) {
    const { enabled, settings } = settingsOf(dir, name)
    if (!enabled) {
      slot(name).status = "off"
      continue
    }
    const loaded = yield* Effect.promise(() => bundle(file, dir))
    const result = yield* build(name, loaded, settings)
    if (result.ok) changes.push({ plugin: name, next: result.version, status: "loaded" })
  }
  yield* swap("boot", changes)
  log("boot.loaded", { live: fs.readlinkSync(LIVE), plugins: changes.map((c) => id(c.next!)) })
}))

/** The ordinary graceful stop: every version that is still open closes. */
export const closeAll = Effect.gen(function*() {
  for (const s of slots.values()) {
    if (s.current !== undefined && s.current.state !== "closed") yield* close(s.current, "graceful stop")
  }
  log("plugins.closed")
})

export const status = () =>
  [...slots.values()].map((s) => s.name + ": " + (s.current ? id(s.current) : s.status) + (s.note ? " (" + s.note + ")" : ""))
