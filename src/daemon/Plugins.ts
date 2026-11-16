import { AgentTools } from "clanka/AgentTools"
import {
  Cause,
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Scope,
} from "effect"
import { Toolkit } from "effect/ai"
import { Chat } from "effect/chat"
import { HttpClient } from "effect/http"
import { KeyValueStore } from "effect/persistence"
import { SqlClient } from "effect/sql"
import * as Messages from "../Messages.ts"
import * as Plugin from "../Plugin.ts"
import {
  CurrentSession,
  type Session,
  type SessionEvent,
  type Turn,
  type TurnEnded,
} from "../Session.ts"
import type { Timings } from "../Timings.ts"
import { Turns } from "../Turns.ts"
import * as Contributions from "./Contributions.ts"
import * as Loader from "./Loader.ts"
import * as Logger from "./Logger.ts"
import type * as Notices from "./Notices.ts"

/**
 * The plugins of the daemon (docs/spec/06-plugin-api.md). Each one is built once, in a scope of its own, with the
 * services of `Plugin.Services`, and what its Layer contributed is read when the build is done. Every place chad runs
 * plugin code is wrapped in the plugin's name and its ConfigProvider (API-26, API-106).
 */

/** A plugin as the daemon is handed it: a name and the value its file exports. */
export interface Entry {
  readonly name: string
  readonly plugin: Plugin.Plugin
  /** The plugin's `settings` object, which its `Config` reads (API-25). */
  readonly settings?: unknown
  /** The bundle of a plugin from the repo, whose source map is kept while the plugin runs (LOAD-85). */
  readonly bundle?: Loader.Bundle
}

/** A plugin that was skipped, and the first line of why (CLI-125). */
export interface Skipped {
  readonly name: string
  readonly reason: string
}

/** The key of the notice about a plugin skipped at boot (REC-101, FAIL-150). */
export const skippedKey = (name: string) => `plugin-skipped:${name}`

/** The hooks, as their names go in log lines and notices. */
export type HookName = "prompt" | "beforeTurn" | "afterTurn" | "onSession"

/** A plugin's count of warning and error lines since it loaded, with the latest of them (FAIL-117). */
export interface Counts {
  warnings: number
  errors: number
  latest: string | undefined
}

/** One loaded plugin. */
interface Loaded {
  readonly name: string
  readonly scope: Scope.Closeable
  readonly contributions: Contributions.Contributions
  readonly provider: ConfigProvider.ConfigProvider
  readonly counts: Counts
  /** The hooks that failed in a row, by hook name. */
  readonly failures: Map<HookName, number>
  readonly active: Deferred.Deferred<void>
}

/** One call off the reply path, queued for a plugin. */
type Job = Effect.Effect<void>

export class Plugins extends Context.Service<
  Plugins,
  {
    /** Done once every plugin of the boot is loaded and active. A turn waits for it before it starts. */
    readonly ready: Effect.Effect<void>
    /**
     * Every plugin's tools for one session's Agent, with their handlers wrapped so each call runs under its plugin
     * with the session (API-30, API-31, API-106). Nothing when no plugin has a tool.
     */
    readonly tools: (current: CurrentSession["Service"]) =>
      | {
          readonly toolkit: Toolkit.Any
          readonly context: Context.Context<never>
        }
      | undefined
    /**
     * Every plugin's chunk for a session, by plugin name. A render that failed or ran past its budget gives
     * `undefined`, which keeps the text the session last saw (API-40). An empty text is no chunk (API-38).
     */
    readonly chunks: (
      session: Session,
    ) => Effect.Effect<ReadonlyMap<string, string | undefined>>
    /** The `beforeTurn` texts, in plugin name order (API-49). */
    readonly beforeTurn: (
      turn: Turn,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly plugin: string; readonly text: string }>
    >
    /** Queues the `afterTurn` hooks of a turn that ended (API-53). */
    readonly afterTurn: (ended: TurnEnded) => Effect.Effect<void>
    /**
     * Queues the `onSession` hooks of an event, and gives a wait for the end of every plugin's queue up to and
     * including it, each call inside its budget (API-58, SWAP-38, SWAP-150).
     */
    readonly onSession: (
      event: SessionEvent,
    ) => Effect.Effect<Effect.Effect<void>>
    /** Each loaded plugin's counts, in name order (FAIL-117). */
    readonly status: () => ReadonlyArray<{
      readonly name: string
      readonly counts: Counts
    }>
    /** The plugins skipped at boot and why, in name order (CLI-125). */
    readonly skipped: () => ReadonlyArray<Skipped>
  }
>()("chad/Plugins") {}

/** The host with no plugin, for a daemon that is given none. */
export const empty: Plugins["Service"] = {
  ready: Effect.void,
  tools: () => undefined,
  chunks: () => Effect.succeed(new Map()),
  beforeTurn: () => Effect.succeed([]),
  afterTurn: () => Effect.void,
  onSession: () => Effect.succeed(Effect.void),
  status: () => [],
  skipped: () => [],
}

/** The services the host supplies to every plugin, apart from its own `PluginContext` and `Turns`. */
export type Supplied =
  | Chat.Chat
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | SqlClient.SqlClient

/** The names clanka gives its own tools, which no plugin tool may take (API-33). */
const clankaTools: ReadonlySet<string> = new Set([
  ...Object.keys(AgentTools.tools),
  "mcp",
  "searchTools",
  "readSkill",
])

/**
 * Loads the plugins and runs them until the scope it is made in closes. A plugin whose load fails is skipped and
 * logged, and the others carry on. A graceful stop runs the hooks still queued, up to `stopHooksUntil` after the stop
 * began, before it closes the plugins' scopes and their queues (API-67, IMG-83).
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly entries: ReadonlyArray<Entry>
  /** The plugins from the repo that could not be bundled or run, which are skipped as one whose Layer fails is. */
  readonly unloadable?: ReadonlyArray<Loader.Skipped>
  readonly owners: () => ReadonlyArray<string>
  readonly timings: Timings
  /** When the stop began, in milliseconds since the epoch, or nothing before a stop. */
  readonly stopping: () => number | undefined
  readonly notices: Notices.Notices["Service"]
  /** The `Turns` of one plugin. Each call waits for the plugin's activation before it reaches here. */
  readonly turns: (plugin: string) => Turns["Service"]
}) {
  const outer = yield* Effect.scope
  // The plugins' scopes and their queues' workers live in a scope of their own. It is forked before the drain's
  // finalizer is added, so a stop runs the drain first and closes them only after it (API-67).
  const scope = yield* Scope.fork(outer)
  const supplied = yield* Effect.context<Supplied>()
  const timings = options.timings
  const loaded: Array<Loaded> = []
  const skipped: Array<Skipped> = []
  const ready = yield* Deferred.make<void>()

  /**
   * A plugin that is skipped at boot: a log line with the error, a line in `chad status`, and a notice to the owner
   * under its key, which a plugin skipped at every boot sends once (FAIL-268, CLI-125, REC-101, FAIL-150).
   */
  const skip = (name: string, error: string, cause?: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      const reason = Messages.firstLine(error)
      skipped.push({ name, reason })
      yield* Logger.event(
        "plugin.skipped",
        "A plugin was skipped",
        { plugin: name, reason, ...(cause === undefined ? { error } : {}) },
        cause,
      )
      yield* options.notices.raise({
        key: skippedKey(name),
        text: Messages.pluginSkipped(name, reason),
      })
    })

  /**
   * Runs an effect as the plugin's: its name on every line, its settings for every `Config` read, and no `SqlClient`
   * from the daemon's context, which a plugin never reaches (STO-56).
   */
  const as =
    (plugin: Loaded) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        // Frames inside a bundle name the source file, both in the log and in the error the model reads (LOAD-86).
        Effect.tapCause((cause) => Effect.sync(() => Loader.remap(cause))),
        Effect.updateContext(
          (context: Context.Context<R>) =>
            Context.omit(SqlClient.SqlClient)(context) as Context.Context<R>,
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, plugin.provider),
        Effect.provideService(Logger.PluginName, plugin.name),
        Effect.provideService(Logger.PluginCounts, plugin.counts),
      )

  // The queue of each plugin's calls off the reply path belongs to its name, and outlives a version (API-64).
  const queues = new Map<string, Queue.Queue<Job>>()
  let pending = 0
  const idle = { waiters: [] as Array<Deferred.Deferred<void>> }
  const settled = () => {
    if (pending > 0) return
    for (const waiter of idle.waiters.splice(0)) {
      Deferred.doneUnsafe(waiter, Exit.void)
    }
  }
  const queueOf = Effect.fnUntraced(function* (name: string) {
    const existing = queues.get(name)
    if (existing !== undefined) return existing
    const queue = yield* Queue.unbounded<Job>()
    queues.set(name, queue)
    yield* Queue.take(queue).pipe(
      Effect.flatMap((job) =>
        job.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pending--
              settled()
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    )
    return queue
  })
  const enqueue = (name: string, job: Job) =>
    Effect.gen(function* () {
      const queue = yield* queueOf(name)
      pending++
      yield* Queue.offer(queue, job)
    })

  /**
   * Runs one hook inside its budget. A hook that fails, dies or runs past it is logged and skipped (API-43). The
   * third failure in a row sends the owner one notice, and a success clears it (API-44, FAIL-163).
   */
  const run = <A, B>(
    plugin: Loaded,
    hook: HookName,
    registered: Contributions.Hook<A, B>,
    input: A,
    budget: Duration.Duration,
  ): Effect.Effect<Option.Option<B>> =>
    Effect.gen(function* () {
      const key = `hook-failing:${plugin.name}:${hook}`
      // The hook runs on a fiber of its plugin's scope, and the caller waits on it only up to the budget. A hook past
      // its budget is interrupted without waiting, so one that cannot be interrupted holds up nothing but itself and
      // its plugin's scope (API-43).
      const fiber = yield* registered
        .run(input)
        .pipe(as(plugin), Logger.ownConsole, Effect.forkIn(plugin.scope))
      const abandon = Effect.sync(() => fiber.interruptUnsafe())
      const exit = yield* Fiber.await(fiber).pipe(
        Effect.timeoutOption(registered.timeout ?? budget),
        Effect.onInterrupt(() => abandon),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.as(abandon, Exit.succeed(Option.none<B>())),
            onSome: (exit) =>
              Effect.succeed(Exit.map(exit, (value) => Option.some(value))),
          }),
        ),
      )
      if (Exit.isSuccess(exit) && Option.isSome(exit.value)) {
        if ((plugin.failures.get(hook) ?? 0) > 0) {
          plugin.failures.set(hook, 0)
          yield* options.notices.clear(key)
        }
        return exit.value
      }
      // An interrupt from outside is the caller's, as a stop's, and no failure of the hook's.
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.interrupt
      }
      const timedOut = Exit.isSuccess(exit)
      const first = timedOut
        ? Messages.hookTimedOut
        : Messages.firstLine(Cause.pretty(exit.cause))
      yield* Logger.event(
        "hook.failed",
        "A plugin's hook failed and was skipped",
        { plugin: plugin.name, hook, reason: timedOut ? "timeout" : "failed" },
        Exit.isFailure(exit) ? exit.cause : undefined,
      )
      const count = (plugin.failures.get(hook) ?? 0) + 1
      plugin.failures.set(hook, count)
      if (count === 3) {
        yield* Logger.event(
          "hook.failing",
          "A plugin's hook failed 3 times in a row",
          { plugin: plugin.name, hook },
        )
        yield* options.notices.raise({
          key,
          text: Messages.hookFailing(plugin.name, hook, first),
        })
      }
      return Option.none<B>()
    })

  /** Builds one plugin. A failure closes its scope and is the load's error. */
  const load = (entry: Entry) =>
    Effect.gen(function* () {
      const own = yield* Scope.fork(scope)
      if (entry.bundle !== undefined) yield* Loader.register(entry.bundle, own)
      const plugin: Loaded = {
        name: entry.name,
        scope: own,
        contributions: Contributions.empty(),
        provider: ConfigProvider.fromUnknown(entry.settings ?? {}),
        counts: { warnings: 0, errors: 0, latest: undefined },
        failures: new Map(),
        active: Deferred.makeUnsafe(),
      }
      const built = yield* Effect.exit(
        Effect.gen(function* () {
          // The table is named after the plugin and quoted by `layerSql` (STO-57, STO-162).
          const store = yield* Layer.buildWithScope(
            KeyValueStore.layerSql({ table: `plugin_kv_${entry.name}` }),
            own,
          ).pipe(Effect.provideContext(supplied))
          const context = {
            name: entry.name,
            store: Context.get(store, KeyValueStore.KeyValueStore),
            owners: options.owners(),
            [Contributions.key]: plugin.contributions,
          }
          const turns = options.turns(entry.name)
          const waiting = <A>(effect: Effect.Effect<A>) =>
            Effect.andThen(Deferred.await(plugin.active), effect)
          // A plugin gets only the services of its API. The daemon's own, `SqlClient` among them, stay out of reach
          // (STO-56).
          const services = Context.mergeAll(
            Context.pick(
              Chat.Chat,
              HttpClient.HttpClient,
              FileSystem.FileSystem,
              Path.Path,
            )(supplied),
            Context.make(Plugin.PluginContext, context),
            Context.make(
              Turns,
              Turns.of({
                start: (options) => waiting(turns.start(options)),
                queue: (options) => waiting(turns.queue(options)),
                schedule: (options) => waiting(turns.schedule(options)),
                cancel: (name) => waiting(turns.cancel(name)),
                scheduled: () => waiting(turns.scheduled()),
              }),
            ),
            Context.make(DateTime.CurrentTimeZone, DateTime.zoneMakeLocal()),
          )
          // The daemon owns the deadline of the build. A `Turns` call the build waits on never returns, and the deadline
          // ends it (LOAD-14, API-131). The build runs on a fiber of its own, so a part of it that cannot be interrupted,
          // such as an `acquireRelease` acquisition, holds only that fiber: it is interrupted without a wait.
          const building = yield* Layer.buildWithScope(entry.plugin, own).pipe(
            Effect.provideContext(services),
            as(plugin),
            Logger.ownConsole,
            Effect.forkDetach,
          )
          const ended = yield* Effect.timeoutOption(
            Fiber.await(building),
            timings.pluginBuild,
          )
          if (Option.isNone(ended)) {
            yield* Effect.forkDetach(Fiber.interrupt(building))
            return yield* Effect.fail(
              Messages.buildTimedOut(Duration.toSeconds(timings.pluginBuild)),
            )
          }
          yield* ended.value
          // A tool name that clanka or a plugin loaded before already has fails the load, and names who has it
          // (API-33).
          for (const { toolkit } of plugin.contributions.toolkits) {
            for (const name of Object.keys(toolkit.tools)) {
              if (clankaTools.has(name)) {
                return yield* Effect.fail(Messages.toolTaken(name, "clanka"))
              }
              const holder = loaded.find((other) =>
                other.contributions.toolkits.some(({ toolkit }) =>
                  Object.hasOwn(toolkit.tools, name),
                ),
              )
              if (holder !== undefined) {
                return yield* Effect.fail(
                  Messages.toolTaken(name, `the plugin ${holder.name}`),
                )
              }
            }
          }
        }),
      )
      if (Exit.isFailure(built)) {
        // The finalizers of a failed build get the same deadline, and one that has not ended by then goes on alone.
        yield* Effect.timeoutOption(
          Fiber.await(yield* Effect.forkDetach(Scope.close(own, Exit.void))),
          timings.pluginBuild,
        )
        yield* skip(entry.name, Cause.pretty(built.cause), built.cause)
        return
      }
      loaded.push(plugin)
      yield* options.notices.clear(skippedKey(entry.name))
    })

  /** Starts a version's background fibers and lets its `Turns` calls through (API-68, API-80). */
  const activate = (plugin: Loaded) =>
    Effect.gen(function* () {
      for (const background of plugin.contributions.background) {
        yield* background(plugin.scope).pipe(
          as(plugin),
          Logger.ownConsole,
          // A fiber that fails or dies is one error under the plugin's name. One that returns or is interrupted logs
          // nothing, and none is started again (API-108 to API-110).
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError(
                  "A background fiber of the plugin failed",
                  cause,
                ).pipe(as(plugin), Logger.ownConsole),
          ),
          Effect.forkIn(plugin.scope),
        )
      }
      yield* Deferred.succeed(plugin.active, undefined)
    })

  // A graceful stop runs the queued hooks up to their deadline, a point in time from the stop's start, and only then
  // closes the plugins' scopes and their queues (API-67, IMG-83).
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (pending === 0) return
      const done = Deferred.makeUnsafe<void>()
      idle.waiters.push(done)
      const began = options.stopping() ?? Date.now()
      const left = Math.max(
        0,
        began + Duration.toMillis(timings.stopHooksUntil) - Date.now(),
      )
      const drained = yield* Deferred.await(done).pipe(
        Effect.timeoutOption(Duration.millis(left)),
      )
      if (Option.isNone(drained)) {
        yield* Logger.event(
          "hook.dropped",
          "Queued hooks were dropped at the stop",
          { reason: "stop", hooks: pending },
        )
        // The stop's own line says what it dropped, and no notice goes for it (IMG-86, FAIL-296).
        yield* Logger.event("stop.dropped", "The stop dropped queued hooks", {
          hooks: pending,
        })
      }
    }),
  )

  const sorted = [...options.entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  for (const entry of sorted) yield* load(entry)
  for (const { name, message } of options.unloadable ?? []) {
    yield* skip(name, message)
  }
  skipped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const plugin of loaded) yield* activate(plugin)
  yield* Deferred.succeed(ready, undefined)

  const tools: Plugins["Service"]["tools"] = (current) => {
    const owned = loaded.filter(
      (plugin) => plugin.contributions.toolkits.length > 0,
    )
    if (owned.length === 0) return undefined
    const toolkits: Array<Toolkit.Any> = []
    const entries = new Map<string, unknown>()
    for (const plugin of owned) {
      for (const { toolkit, context } of plugin.contributions.toolkits) {
        toolkits.push(toolkit)
        for (const tool of Object.values(toolkit.tools)) {
          const handler = context.mapUnsafe.get(tool.id) as
            | {
                readonly name: string
                readonly handler: (
                  params: unknown,
                  options: unknown,
                ) => Effect.Effect<unknown, unknown, unknown>
                readonly context: Context.Context<never>
              }
            | undefined
          if (handler === undefined) continue
          entries.set(tool.id, {
            ...handler,
            // A tool's log line goes to the calling script's output and to chad's log, under the plugin (API-97).
            handler: (params: unknown, options: unknown) =>
              handler
                .handler(params, options)
                .pipe(
                  Effect.provideService(CurrentSession, current),
                  as(plugin),
                ),
          })
        }
      }
    }
    const [head, ...rest] = toolkits
    return {
      toolkit: rest.length === 0 ? head! : Toolkit.merge(head!, ...rest),
      context: Context.makeUnsafe(entries),
    }
  }

  const chunks: Plugins["Service"]["chunks"] = (session) =>
    Effect.gen(function* () {
      const texts = new Map<string, string | undefined>()
      for (const plugin of loaded) {
        if (plugin.contributions.prompts.length === 0) continue
        const parts: Array<string> = []
        let failed = false
        for (const render of plugin.contributions.prompts) {
          const text = yield* run(
            plugin,
            "prompt",
            render,
            session,
            timings.hookPromptChunk,
          )
          if (Option.isNone(text)) failed = true
          else if (text.value !== "") parts.push(text.value)
        }
        texts.set(plugin.name, failed ? undefined : parts.join("\n\n"))
      }
      return texts
    })

  const beforeTurn: Plugins["Service"]["beforeTurn"] = (turn) =>
    Effect.gen(function* () {
      const texts: Array<{ readonly plugin: string; readonly text: string }> =
        []
      for (const plugin of loaded) {
        for (const hook of plugin.contributions.beforeTurn) {
          const text = yield* run(
            plugin,
            "beforeTurn",
            hook,
            turn,
            timings.hookBeforeTurn,
          )
          if (Option.isSome(text) && typeof text.value === "string") {
            texts.push({ plugin: plugin.name, text: text.value })
          }
        }
      }
      return texts
    })

  /** Queues one call of each of a plugin's hooks of a kind, and gives a wait for each plugin's call. */
  const queued = <A>(
    hook: "afterTurn" | "onSession",
    input: A,
    budget: Duration.Duration,
  ) =>
    Effect.gen(function* () {
      const waits: Array<Effect.Effect<void>> = []
      for (const plugin of loaded) {
        const hooks = plugin.contributions[hook] as ReadonlyArray<
          Contributions.Hook<A, void>
        >
        if (hooks.length === 0) continue
        const done = Deferred.makeUnsafe<void>()
        waits.push(Deferred.await(done))
        yield* enqueue(
          plugin.name,
          Effect.forEach(
            hooks,
            (registered) => run(plugin, hook, registered, input, budget),
            { discard: true },
          ).pipe(Effect.ensuring(Deferred.succeed(done, undefined))),
        )
      }
      return Effect.all(waits, { concurrency: "unbounded", discard: true })
    })

  return Plugins.of({
    ready: Deferred.await(ready),
    tools,
    chunks,
    beforeTurn,
    afterTurn: (ended) =>
      Effect.asVoid(queued("afterTurn", ended, timings.hookAfterTurn)),
    onSession: (event) => queued("onSession", event, timings.hookOnSession),
    status: () =>
      loaded.map((plugin) => ({ name: plugin.name, counts: plugin.counts })),
    skipped: () => skipped,
  })
})
