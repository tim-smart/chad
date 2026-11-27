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
import { Chat, ChatInteraction } from "effect/chat"
import { HttpClient } from "effect/http"
import { KeyValueStore } from "effect/persistence"
import { SqlClient } from "effect/sql"
import * as Messages from "../Messages.ts"
import * as Plugin from "../Plugin.ts"
import * as Settings from "../Settings.ts"
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
import { Once, type Store } from "../plugins/request-secret/Once.ts"

/**
 * The plugins of the daemon. Each one is built once, in a scope of its own, with the
 * services of `Plugin.Services`, and what its Layer contributed is read when the build is done. Every place chad runs
 * plugin code is wrapped in the plugin's name and its ConfigProvider.
 */

/** A plugin as the daemon is handed it: a name and the value its file exports. */
export interface Entry {
  readonly name: string
  readonly plugin: Plugin.Plugin
  /**
   * The plugin's `settings` object from `chad.json` as the file holds it, before `${NAME}` is expanded. Its `Config`
   * reads it once expanded, and an apply compares it with the running version's.
   */
  readonly settings?: unknown
  /** The bundle of a plugin from the repo, whose source map is kept while the plugin runs. */
  readonly bundle?: Loader.Bundle
}

/** A plugin that was skipped, and the first line of why. */
export interface Skipped {
  readonly name: string
  readonly reason: string
  /** Whether it came from the repo, which `chad safe on` unloads. */
  readonly repo?: boolean
}

/** The key of the notice about a plugin skipped at boot. */
export const skippedKey = (name: string) => `plugin-skipped:${name}`

/** The hooks, as their names go in log lines and notices. */
export type HookName = "prompt" | "beforeTurn" | "afterTurn" | "onSession"

/** A plugin's count of warning and error lines since it loaded, with the latest of them. */
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
  /** The version's provider, which records what the plugin asks for. */
  readonly recorder: Settings.Recorder
  readonly counts: Counts
  /** The hooks that failed in a row, by hook name. */
  readonly failures: Map<HookName, number>
  readonly active: Deferred.Deferred<void>
  /** What the version was built from, which a reload builds again. */
  readonly entry: Entry
  /** Set when a swap took the version out of service. From then its tools refuse every call. */
  retired: Retired | undefined
  /** The tool calls and hooks running on the version, which a swap's drain waits for. */
  readonly calls: Set<Call>
}

/** Why a version stopped answering: a new version replaced it, the swap removed it, or safe mode switched it off. */
export type Retired = "changed" | "removed" | "safe"

/** One tool call or hook running on a version. */
interface Call {
  readonly fiber: Fiber.Fiber<unknown, unknown>
  /** What it is, for the log line of one that does not stop. */
  readonly kind: "tool" | "hook" | "interaction"
  readonly label: string
  /** Set once the drain interrupted it. */
  cut: boolean
  /** Done when the drain stopped waiting for it to end. */
  readonly abandoned: Deferred.Deferred<void>
}

/** How a tracked call ended: its own exit, or cut by a swap, which says whether it stopped within the wait. */
type Outcome<A, E> =
  | { readonly _tag: "Ended"; readonly exit: Exit.Exit<A, E> }
  | { readonly _tag: "Cut"; readonly stopped: boolean }

/** What a swap is asked to do. */
export interface Plan {
  /** The new versions, each replacing the running one of its name or added beside the others. */
  readonly build: ReadonlyArray<Entry>
  /** The names unloaded, and why their tools now refuse. */
  readonly remove: ReadonlyArray<string>
  readonly reason: "removed" | "safe"
  /**
   * What a build that fails does: `refuse` fails the whole plan and swaps nothing (an apply), `keep` leaves
   * the running version (a reload), and `skip` skips the plugin as a boot does (`chad safe off`).
   */
  readonly failures: "refuse" | "keep" | "skip"
  /** Whether the trial `Agent.makeWith` with every plugin's tools runs before anything swaps. */
  readonly trial: boolean
  /** Plugins from the repo that could not be bundled or run, skipped as a boot skips them (`chad safe off`). */
  readonly unloadable?: ReadonlyArray<Loader.Skipped>
  /**
   * With `keep`, the word for what changed. A plugin that keeps its running version is marked "running with the previous
   * <word>: <error>" in `chad status` until a later build of it swaps.
   */
  readonly kept?: "owners" | "instance" | "timezone" | "secret"
}

/** What a swap did, for the command's output. */
export interface Swapped {
  readonly swapped: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  /** How long the drain waited for work in flight. */
  readonly waited: number
  /** The calls it interrupted at its deadline. */
  readonly interrupted: ReadonlyArray<string>
  /** The sessions with a running turn whose Agent has tools that the swap took away, with their sub-agents and background tasks. */
  readonly affected: ReadonlyArray<{
    readonly session: string
    readonly subagents: number
    readonly tasks: number
  }>
}

/** The settings a new version read while loading and the keys it did not read, for the listing. */
export interface Listing {
  readonly name: string
  readonly items: ReadonlyArray<Settings.Item>
  readonly unread: ReadonlyArray<string>
}

/** A plan whose builds have run. Exactly one of `swap` and `discard` runs next. */
export interface Prepared {
  /** The plugins whose build failed, with the error. */
  readonly failed: ReadonlyArray<{
    readonly name: string
    readonly error: string
  }>
  /** The builds that succeeded. */
  readonly built: ReadonlyArray<string>
  /** The settings listing of each build that succeeded, in name order. */
  readonly settings: ReadonlyArray<Listing>
  /** The tools of the new versions whose description starts with "Replace me", which an apply refuses. */
  readonly replaceMe: ReadonlyArray<string>
  readonly swap: Effect.Effect<Swapped>
  readonly discard: Effect.Effect<void>
}

/** A plugin as `versions` lists it: its name, its bundle's hash and whether it came from the repo. */
export interface Version {
  readonly name: string
  readonly hash: string | undefined
  readonly entry: Entry
}

/** One call off the reply path, queued under a plugin's name. The version that runs it is looked up when its turn
 * comes. */
interface Job {
  readonly hook: "afterTurn" | "onSession"
  readonly input: unknown
  readonly budget: Duration.Duration
  readonly done: Deferred.Deferred<void>
}

export class Plugins extends Context.Service<
  Plugins,
  {
    /** Done once every plugin of the boot is loaded and active. A turn waits for it before it starts. */
    readonly ready: Effect.Effect<void>
    /**
     * Every plugin's tools for one session's Agent, with their handlers wrapped so each call runs under its plugin
     * with the session. Nothing when no plugin has a tool.
     */
    readonly tools: (
      current: CurrentSession["Service"],
      /** How many sub-agents the session's running turn has, which picks the refusal. */
      subagents?: () => number,
      /** How many background tasks the session has running, which the apply output counts. */
      tasks?: () => number,
    ) =>
      | {
          readonly toolkit: Toolkit.Any
          readonly context: Context.Context<never>
        }
      | undefined
    /**
     * Every plugin's chunk for a session, by plugin name. A render that failed or ran past its budget gives
     * `undefined`, which keeps the text the session last saw. An empty text is no chunk.
     */
    readonly chunks: (
      session: Session,
    ) => Effect.Effect<ReadonlyMap<string, string | undefined>>
    /** The `beforeTurn` texts, in plugin name order. */
    readonly beforeTurn: (
      turn: Turn,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly plugin: string; readonly text: string }>
    >
    /** Queues the `afterTurn` hooks of a turn that ended. */
    readonly afterTurn: (ended: TurnEnded) => Effect.Effect<void>
    /**
     * Queues the `onSession` hooks of an event, and gives a wait for the end of every plugin's queue up to and
     * including it, each call inside its budget.
     */
    readonly onSession: (
      event: SessionEvent,
    ) => Effect.Effect<Effect.Effect<void>>
    /** Each loaded plugin's counts, in name order. */
    readonly status: () => ReadonlyArray<{
      readonly name: string
      readonly counts: Counts
      /** The mark of a plugin that kept its running version when a reload failed to build it. */
      readonly previous?: string
      /** The keys it read at load and since, with no value. */
      readonly settings: ReadonlyArray<Settings.Item>
    }>
    /** The plugins skipped at boot and why, in name order. */
    readonly skipped: () => ReadonlyArray<Skipped>
    /** The number of swaps that changed something. A session behind it rebuilds its Agent at its next turn. */
    readonly generation: () => number
    /** The running versions, in name order. */
    readonly versions: () => ReadonlyArray<Version>
    /** Builds what a plan needs and gives the swap to run, or to discard. */
    readonly prepare: (plan: Plan) => Effect.Effect<Prepared>
    /** Abandons a swap that is running, which a graceful stop does first. */
    readonly abandon: Effect.Effect<void>
    /** Whether the plugin of that name has a version that is active and in no swap, so its timers can fire. */
    readonly active: (name: string) => boolean
    /**
     * Waits until the plugin of that name is active and in no swap. A timer of a plugin that is not loaded, is off or
     * is in the middle of a swap waits here, inside its request.
     */
    readonly whenActive: (name: string) => Effect.Effect<void>
    /**
     * Runs the handler a plugin registered for the click's or submit's id, on the version loaded when it arrives,
     * and gives its answer. The caller checks that an owner sent it. While a swap of the plugin runs, it waits for the
     * new version. An id no plugin holds, a handler that fails and a value that no longer decodes are answered `ack`,
     * or `close` for a submit.
     */
    readonly interactions: Pick<
      ChatInteraction.Handler["Service"],
      "click" | "submit"
    >
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
  generation: () => 0,
  versions: () => [],
  prepare: () =>
    Effect.succeed({
      failed: [],
      built: [],
      settings: [],
      replaceMe: [],
      swap: Effect.succeed({
        swapped: [],
        removed: [],
        waited: 0,
        interrupted: [],
        affected: [],
      }),
      discard: Effect.void,
    }),
  abandon: Effect.void,
  active: () => false,
  whenActive: () => Effect.never,
  interactions: {
    click: () => Effect.succeed(ChatInteraction.ack),
    submit: () => Effect.succeed(ChatInteraction.close),
  },
}

/** The services the host supplies to every plugin, apart from its own `PluginContext` and `Turns`. */
export type Supplied =
  | Chat.Chat
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | SqlClient.SqlClient

/** The names clanka gives its own tools, which no plugin tool may take. */
const clankaTools: ReadonlySet<string> = new Set([
  ...Object.keys(AgentTools.tools),
  "mcp",
  "searchTools",
  "readSkill",
])

/**
 * Loads the plugins and runs them until the scope it is made in closes. A plugin whose load fails is skipped and
 * logged, and the others carry on. A graceful stop runs the hooks still queued, up to `stopHooksUntil` after the stop
 * began, before it closes the plugins' scopes and their queues. A swap replaces versions while the daemon runs, in
 * order: the builds, the gate, the drain, the close and the activation.
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly entries: ReadonlyArray<Entry>
  /** The plugins from the repo that could not be bundled or run, which are skipped as one whose Layer fails is. */
  readonly unloadable?: ReadonlyArray<Loader.Skipped>
  readonly owners: () => ReadonlyArray<string>
  /** The button, select, form and slash command ids chad holds itself, which no plugin may take. */
  readonly reserved: ReadonlySet<string>
  /** The owner's timezone, which a plugin reads as `DateTime.CurrentTimeZone` and gets at load. */
  readonly timezone: () => string
  readonly timings: Timings
  /** The daemon's `requestOnce` requests and `fillSecret` fills, which only a bundled plugin is given (`Once.ts`). */
  readonly once?: Store
  /** When the stop began, in milliseconds since the epoch, or nothing before a stop. */
  readonly stopping: () => number | undefined
  readonly notices: Notices.Notices["Service"]
  /** The `Turns` of one plugin. Each call waits for the plugin's activation before it reaches here. */
  readonly turns: (plugin: string) => Turns["Service"]
  /**
   * Where a `${NAME}` in a plugin's settings finds its value: the secret store, then process env. With none,
   * a name resolves nowhere.
   */
  readonly lookup?: Settings.Lookup<{ readonly message: string }, never>
  readonly scrubBuildError: (
    settings: unknown,
    error: string,
  ) => Effect.Effect<string>
  /** The trial `Agent.makeWith` with a set of plugin tools, which fails with clanka's error. */
  readonly trial?: (
    tools: NonNullable<ReturnType<Plugins["Service"]["tools"]>>,
  ) => Effect.Effect<void, string>
}) {
  const outer = yield* Effect.scope
  // The plugins' scopes and their queues' workers live in a scope of their own. It is forked before the drain's
  // finalizer is added, so a stop runs the drain first and closes them only after it.
  const scope = yield* Scope.fork(outer)
  const supplied = yield* Effect.context<Supplied>()
  const timings = options.timings
  /** The running version of each plugin, by name. */
  const current = new Map<string, Loaded>()
  const loaded = () =>
    [...current.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
  let skipped: Array<Skipped> = []
  const ready = yield* Deferred.make<void>()
  let generation = 0
  /** Each session's latest Agent build, which says whether its turn runs and how many sub-agents it has. */
  const agents = new Map<
    string,
    {
      readonly current: CurrentSession["Service"]
      readonly subagents: () => number
      readonly tasks: () => number
    }
  >()
  /** The swap that is running: the names it changes, its gate, and its fiber, which a stop interrupts. */
  let swapping:
    | {
        readonly names: ReadonlySet<string>
        readonly gate: Deferred.Deferred<void>
        fiber: Fiber.Fiber<unknown, unknown> | undefined
      }
    | undefined
  /** A stop has abandoned the swaps, so one that has not begun does nothing. */
  let abandoned = false
  /** The marks of plugins that kept their running version, by name. */
  const previous = new Map<string, string>()
  /** Done, and replaced, whenever a version is activated or a swap ends, which is when a held timer looks again. */
  let changed = Deferred.makeUnsafe<void>()
  const change = () => {
    const done = changed
    changed = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(done, Exit.void)
  }
  const active = (name: string) => {
    const plugin = current.get(name)
    return (
      plugin !== undefined &&
      plugin.retired === undefined &&
      Deferred.isDoneUnsafe(plugin.active) &&
      swapping?.names.has(name) !== true
    )
  }
  const whenActive = (name: string): Effect.Effect<void> =>
    Effect.suspend(() =>
      active(name)
        ? Effect.void
        : Effect.andThen(Deferred.await(changed), whenActive(name)),
    )

  const byName = (
    a: { readonly name: string },
    b: { readonly name: string },
  ) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

  /**
   * A plugin that is skipped at boot: a log line with the error, a line in `chad status`, and a notice to the owner
   * under its key, which a plugin skipped at every boot sends once.
   */
  const skip = Effect.fnUntraced(function* (
    name: string,
    error: string,
    repo: boolean,
  ) {
    const reason = Messages.firstLine(error)
    skipped = [
      ...skipped.filter((other) => other.name !== name),
      { name, reason, repo },
    ].sort(byName)
    yield* Logger.event("plugin.skipped", "A plugin was skipped", {
      plugin: name,
      reason,
      error,
    })
    yield* options.notices.raise({
      key: skippedKey(name),
      text: Messages.pluginSkipped(name, reason),
    })
  })

  /**
   * Runs an effect as the plugin's: its name on every line, its settings for every `Config` read, and no `SqlClient`
   * from the daemon's context, which a plugin never reaches.
   */
  const as =
    (plugin: Loaded) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        // Frames inside a bundle name the source file, both in the log and in the error the model reads.
        Effect.tapCause((cause) => Effect.sync(() => Loader.remap(cause))),
        Effect.updateContext(
          (context: Context.Context<R>) =>
            Context.omit(SqlClient.SqlClient)(context) as Context.Context<R>,
        ),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          plugin.recorder.provider,
        ),
        Effect.provideService(Logger.PluginName, plugin.name),
        Effect.provideService(Logger.PluginCounts, plugin.counts),
      )

  /**
   * Runs a tool call or a hook on a fiber of its version's scope, where a swap's drain finds it. The caller waits for
   * the fiber, or for the drain to give up on it.
   */
  const track = <A, E>(
    plugin: Loaded,
    kind: Call["kind"],
    label: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<Outcome<A, E>> =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(effect, plugin.scope)
      const call: Call = {
        fiber,
        kind,
        label,
        cut: false,
        abandoned: Deferred.makeUnsafe(),
      }
      plugin.calls.add(call)
      return yield* Effect.raceFirst(
        Effect.map(Fiber.await(fiber), (exit): Outcome<A, E> =>
          call.cut &&
          Exit.isFailure(exit) &&
          Cause.hasInterruptsOnly(exit.cause)
            ? { _tag: "Cut", stopped: true }
            : { _tag: "Ended", exit },
        ),
        Effect.as(Deferred.await(call.abandoned), {
          _tag: "Cut",
          stopped: false,
        } as Outcome<A, E>),
      ).pipe(
        Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe())),
        Effect.ensuring(Effect.sync(() => plugin.calls.delete(call))),
      )
    })

  // The queue of each plugin's calls off the reply path belongs to its name, and outlives a version. A job waits while
  // a swap of its plugin runs, and then runs on the version that is current.
  const queues = new Map<string, Queue.Queue<Job>>()
  let pending = 0
  const idle = { waiters: [] as Array<Deferred.Deferred<void>> }
  const settled = () => {
    if (pending > 0) return
    for (const waiter of idle.waiters.splice(0)) {
      Deferred.doneUnsafe(waiter, Exit.void)
    }
  }
  const dropped = (name: string, hook: Job["hook"], reason: string) =>
    Logger.event("hook.dropped", "A queued hook was dropped", {
      plugin: name,
      hook,
      reason,
      hooks: 1,
    })
  const perform = (name: string, job: Job) =>
    Effect.gen(function* () {
      const swap = swapping
      if (swap !== undefined && swap.names.has(name)) {
        yield* Deferred.await(swap.gate)
      }
      const plugin = current.get(name)
      if (plugin === undefined)
        return yield* dropped(name, job.hook, "unloaded")
      const hooks = plugin.contributions[job.hook] as ReadonlyArray<
        Contributions.Hook<unknown, void>
      >
      if (hooks.length === 0)
        return yield* dropped(name, job.hook, "unregistered")
      for (const registered of hooks) {
        // A swap of the plugin ends the job: the callbacks of the old version after the one the drain cut do not start
        // on a version that is closing.
        if (plugin.retired !== undefined) return
        yield* run(plugin, job.hook, registered, job.input, job.budget)
      }
    }).pipe(Effect.ensuring(Deferred.succeed(job.done, undefined)))
  const queueOf = Effect.fnUntraced(function* (name: string) {
    const existing = queues.get(name)
    if (existing !== undefined) return existing
    const queue = yield* Queue.unbounded<Job>()
    queues.set(name, queue)
    yield* Queue.take(queue).pipe(
      Effect.flatMap((job) =>
        perform(name, job).pipe(
          // A call interrupted by its version's close ends that job and not the queue, which outlives the version.
          Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void),
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
  const enqueue = Effect.fnUntraced(function* (name: string, job: Job) {
    const queue = yield* queueOf(name)
    pending++
    yield* Queue.offer(queue, job)
  })

  /**
   * Runs one hook inside its budget. A hook that fails, dies or runs past it is logged and skipped. The
   * third failure in a row sends the owner one notice, and a success clears it.
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
      // its plugin's scope. One that a swap's drain cut is logged as a hook past its budget.
      const outcome = yield* track(
        plugin,
        "hook",
        hook,
        registered.run(input).pipe(as(plugin), Logger.ownConsole),
      ).pipe(Effect.timeoutOption(registered.timeout ?? budget))
      const exit: Exit.Exit<Option.Option<B>, unknown> = Option.isNone(
        outcome,
      ) || outcome.value._tag === "Cut"
        ? Exit.succeed(Option.none<B>())
        : Exit.map(outcome.value.exit, (value) => Option.some(value))
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

  /**
   * Builds one version of a plugin, which is not active until `activate` runs. A tool name that clanka or one of
   * `others` holds fails the build. A failure closes its scope and gives the error.
   */
  const lookup: Settings.Lookup<{ readonly message: string }, never> =
    options.lookup ?? (() => Effect.succeedNone)

  /**
   * The names the plugins share, tool names and interaction ids: a version's names, who holds some of them before any
   * plugin loads, and the load error of a name that is taken.
   */
  const spaces = [
    {
      names: (plugin: Loaded) =>
        plugin.contributions.toolkits.flatMap(({ toolkit }) =>
          Object.keys(toolkit.tools),
        ),
      reserved: clankaTools,
      reservedBy: "clanka",
      taken: Messages.toolTaken,
    },
    {
      names: (plugin: Loaded) =>
        plugin.contributions.interactions.map(
          ({ definition }) => definition.id,
        ),
      reserved: options.reserved,
      reservedBy: "chad",
      taken: Messages.interactionTaken,
    },
  ]

  /** The first of a version's names that one of `others` holds, with the holder and the load error that names it. */
  const taken = (plugin: Loaded, others: Iterable<Loaded>) => {
    const list = [...others]
    for (const space of spaces) {
      for (const name of space.names(plugin)) {
        const holder = list.find((other) => space.names(other).includes(name))
        if (holder !== undefined) {
          return {
            holder,
            error: space.taken(name, `the plugin ${holder.name}`),
          }
        }
      }
    }
    return undefined
  }

  const build = Effect.fnUntraced(function* (
    entry: Entry,
    others: () => Iterable<Loaded>,
  ) {
    // `${NAME}` is expanded before the provider is built, and a name that resolves nowhere fails the load.
    const expanded = yield* Effect.result(
      Settings.expand(entry.settings, lookup),
    )
    if (expanded._tag === "Failure") {
      const error = yield* options.scrubBuildError(
        entry.settings,
        expanded.failure.message,
      )
      return { _tag: "Failed", error } as const
    }
    const own = yield* Scope.fork(scope)
    // The build's fiber and the closing of its scope belong to the plugins' scope, so a stop waits for both, up to
    // the stop's deadline. The scope closes only once the build has ended, so nothing it acquired is
    // released while it still runs, and the closing cannot be interrupted.
    let building: Fiber.Fiber<unknown, unknown> | undefined
    const dispose = Effect.suspend(() =>
      building === undefined ? Effect.void : Fiber.interrupt(building),
    ).pipe(
      Effect.andThen(Scope.close(own, Exit.void)),
      Effect.uninterruptible,
      Effect.forkIn(scope),
    )
    let timedOut = false
    if (entry.bundle !== undefined) yield* Loader.register(entry.bundle, own)
    const plugin: Loaded = {
      name: entry.name,
      scope: own,
      contributions: Contributions.empty(),
      recorder: Settings.recorder(expanded.success),
      counts: { warnings: 0, errors: 0, latest: undefined },
      failures: new Map(),
      active: Deferred.makeUnsafe(),
      entry,
      retired: undefined,
      calls: new Set(),
    }
    const built = yield* Effect.exit(
      Effect.gen(function* () {
        // The table is named after the plugin and quoted by `layerSql`.
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
        // A plugin gets only the services of its API. The daemon's own, `SqlClient` among them, stay out of reach.
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
          Context.make(
            DateTime.CurrentTimeZone,
            DateTime.zoneMakeNamedUnsafe(options.timezone()),
          ),
          // A plugin from the repo has a bundle, and is not given the `requestOnce` requests or the filler.
          Context.make(
            Once,
            entry.bundle === undefined ? options.once : undefined,
          ),
        )
        // The daemon owns the deadline of the build. A `Turns` call the build waits on never returns, and the deadline
        // ends it. The build runs on a fiber of its own, so a part of it that cannot be interrupted,
        // such as an `acquireRelease` acquisition, holds only that fiber and not the boot.
        const fiber = yield* Layer.buildWithScope(entry.plugin, own).pipe(
          Effect.provideContext(services),
          as(plugin),
          Logger.ownConsole,
          Effect.forkIn(scope),
        )
        building = fiber
        const ended = yield* Fiber.await(fiber).pipe(
          Effect.timeoutOption(timings.pluginBuild),
          Effect.onInterrupt(() => dispose),
        )
        if (Option.isNone(ended)) {
          timedOut = true
          return yield* Effect.fail(
            Messages.buildTimedOut(Duration.toSeconds(timings.pluginBuild)),
          )
        }
        yield* ended.value
        // A tool name that clanka holds, or an interaction id that chad holds or the plugin registered twice, fails the
        // load, as does either name held by a plugin loaded before. The error names who has it.
        for (const space of spaces) {
          for (const name of space.names(plugin)) {
            if (space.reserved.has(name)) {
              return yield* Effect.fail(space.taken(name, space.reservedBy))
            }
          }
        }
        const ids = plugin.contributions.interactions.map(
          ({ definition }) => definition.id,
        )
        const twice = ids.find((id, at) => ids.indexOf(id) !== at)
        if (twice !== undefined) {
          return yield* Effect.fail(
            Messages.interactionTaken(twice, `the plugin ${entry.name}`),
          )
        }
        const clash = taken(plugin, others())
        if (clash !== undefined) return yield* Effect.fail(clash.error)
      }),
    )
    if (Exit.isFailure(built)) {
      // The finalizers of a failed build get the same deadline. A build past its deadline is not waited for again.
      // Either goes on in the plugins' scope after that.
      const disposing = yield* dispose
      if (!timedOut) {
        yield* Effect.timeoutOption(Fiber.await(disposing), timings.pluginBuild)
      }
      return {
        _tag: "Failed",
        error: yield* options.scrubBuildError(
          entry.settings,
          Cause.pretty(built.cause),
        ),
      } as const
    }
    // A read from here on is a read at call time.
    plugin.recorder.loaded()
    return { _tag: "Built", plugin, dispose } as const
  })

  /** Starts a version's background fibers and lets its `Turns` calls through. */
  const activate = Effect.fnUntraced(function* (plugin: Loaded) {
    for (const background of plugin.contributions.background) {
      yield* background(plugin.scope).pipe(
        as(plugin),
        Logger.ownConsole,
        // A fiber that fails or dies is one error under the plugin's name. One that returns or is interrupted logs
        // nothing, and none is started again.
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
    change()
  })

  /**
   * The drain of a swap: the calls running on the old versions get until the drain deadline to end. Those still
   * running are interrupted and get the interrupt wait to stop, and the caller of each is answered then. One that did
   * not stop is logged now and again when it ends.
   */
  const drain = Effect.fnUntraced(function* (olds: ReadonlyArray<Loaded>) {
    const began = Date.now()
    const open = () =>
      olds.flatMap((plugin) =>
        [...plugin.calls].map((call) => ({ plugin, call })),
      )
    yield* Effect.forEach(open(), ({ call }) => Fiber.await(call.fiber), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.timeoutOption(timings.swapDrain))
    const left = open().filter(
      ({ call }) => call.fiber.pollUnsafe() === undefined,
    )
    for (const { call } of left) {
      call.cut = true
      call.fiber.interruptUnsafe()
    }
    yield* Effect.forEach(left, ({ call }) => Fiber.await(call.fiber), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.timeoutOption(timings.swapInterruptWait))
    for (const { plugin, call } of left) {
      if (call.fiber.pollUnsafe() !== undefined) continue
      Deferred.doneUnsafe(call.abandoned, Exit.void)
      const fields = {
        plugin: plugin.name,
        kind: call.kind,
        name: call.label,
      }
      yield* Logger.event(
        "swap.overrun",
        call.kind === "hook"
          ? Messages.overrunHook(plugin.name, call.label)
          : Messages.overrunTool(plugin.name, call.label),
        fields,
      )
      yield* Fiber.await(call.fiber).pipe(
        Effect.andThen(
          Logger.event(
            "swap.overrun-ended",
            Messages.overrunEnded(plugin.name, call.label),
            fields,
          ),
        ),
        Effect.forkIn(scope),
      )
    }
    return {
      waited: Date.now() - began,
      interrupted: left.map(
        ({ plugin, call }) => `${plugin.name} ${call.kind} ${call.label}`,
      ),
    }
  })

  /**
   * Closes old versions, with the close deadline less what the interrupt wait used. A close past it is abandoned and
   * logged, and the swap goes on without it. The close still runs on a fiber of the plugins' scope, so a later stop
   * waits for it as for anything else still open, up to the stop's deadline.
   */
  const close = (olds: ReadonlyArray<Loaded>, deadline: Duration.Duration) =>
    Effect.forEach(
      olds,
      (old) =>
        Effect.gen(function* () {
          const closing = yield* Scope.close(old.scope, Exit.void).pipe(
            Effect.forkIn(scope, { uninterruptible: true }),
          )
          const closed = yield* Fiber.await(closing).pipe(
            Effect.interruptible,
            Effect.timeoutOption(deadline),
          )
          if (Option.isNone(closed)) {
            yield* Logger.event(
              "swap.close-abandoned",
              Messages.closeAbandoned(old.name),
              {
                plugin: old.name,
              },
            )
          }
        }).pipe(Effect.uninterruptible),
      { concurrency: "unbounded", discard: true },
    )

  const prepare = (plan: Plan): Effect.Effect<Prepared> =>
    Effect.gen(function* () {
      const replaced = new Set([
        ...plan.build.map(({ name }) => name),
        ...plan.remove,
      ])
      const built: Array<{
        readonly plugin: Loaded
        readonly dispose: Effect.Effect<unknown>
      }> = []
      const failed: Array<{ readonly name: string; readonly error: string }> =
        []
      // A new version's tool names are checked against the versions that stay and the new ones built before it.
      const others = () => [
        ...[...current.values()].filter(({ name }) => !replaced.has(name)),
        ...built.map(({ plugin }) => plugin),
      ]
      for (const entry of [...plan.build].sort(byName)) {
        const result = yield* build(entry, others)
        if (result._tag === "Built") {
          built.push(result)
          continue
        }
        failed.push({ name: entry.name, error: result.error })
        if (plan.failures === "skip") {
          yield* skip(entry.name, result.error, entry.bundle !== undefined)
        }
        if (plan.failures === "refuse") break
      }
      // With `keep` the running version of a plugin that failed to rebuild stays, so a new version that took one of its
      // tool names or interaction ids would shadow it. That new version fails as well, and the check runs again for the version it keeps.
      for (let clashed = plan.failures === "keep"; clashed;) {
        clashed = false
        const failedNames = new Set(failed.map(({ name }) => name))
        const kept = [...current.values()].filter(
          ({ name }) => !replaced.has(name) || failedNames.has(name),
        )
        for (const result of built) {
          const clash = taken(result.plugin, kept)
          if (clash === undefined) continue
          built.splice(built.indexOf(result), 1)
          yield* result.dispose
          failed.push({
            name: result.plugin.name,
            error: yield* options.scrubBuildError(
              [result.plugin.entry.settings, clash.holder.entry.settings],
              clash.error,
            ),
          })
          clashed = true
          break
        }
      }
      if (plan.failures === "keep" && plan.kept !== undefined) {
        for (const { name, error } of failed) {
          if (current.has(name))
            previous.set(name, Messages.runningPrevious(plan.kept, error))
        }
      }
      const discard = Effect.forEach(built, ({ dispose }) => dispose, {
        discard: true,
      })
      if (failed.length === 0 && plan.trial && options.trial !== undefined) {
        const tools = toolsOf([...others()], undefined, () => 0)
        if (tools !== undefined) {
          const trial = yield* Effect.result(options.trial(tools))
          if (trial._tag === "Failure")
            failed.push({
              name: "",
              error: Messages.firstLine(
                yield* options.scrubBuildError(
                  others().map(({ entry }) => entry.settings),
                  trial.failure,
                ),
              ),
            })
        }
      }
      const nothing: Swapped = {
        swapped: [],
        removed: [],
        waited: 0,
        interrupted: [],
        affected: [],
      }
      if (plan.failures === "refuse" && failed.length > 0) {
        return {
          failed,
          built: [],
          settings: [],
          replaceMe: [],
          swap: Effect.succeed(nothing),
          discard,
        }
      }
      // A plugin that failed with `skip` is skipped as a boot skips it, and its running version goes too.
      const unloaded =
        plan.failures === "skip" ? failed.map(({ name }) => name) : []
      const removed = [...plan.remove, ...unloaded].filter((name) =>
        current.has(name),
      )
      const swap = Effect.gen(function* () {
        for (const { name, message } of plan.unloadable ?? []) {
          yield* skip(name, message, true)
        }
        const forgotten = new Set([
          ...built.map(({ plugin }) => plugin.name),
          ...plan.remove,
        ])
        skipped = skipped.filter(({ name }) => !forgotten.has(name))
        // A plugin no longer in the applied repo, or turned off, is no longer skipped.
        for (const name of plan.remove)
          yield* options.notices.clear(skippedKey(name))
        // A stop that came before the swap began abandons it too, and the new versions are closed unused.
        if (abandoned) {
          yield* discard
          return nothing
        }
        // Every activation of the swap path bumps the generation, whatever it changed.
        if (built.length === 0 && removed.length === 0) {
          generation++
          return nothing
        }
        const names = new Set([
          ...built.map(({ plugin }) => plugin.name),
          ...removed,
        ])
        const gate = Deferred.makeUnsafe<void>()
        const swap = {
          names,
          gate,
          fiber: undefined as Fiber.Fiber<unknown, unknown> | undefined,
        }
        const olds: Array<Loaded> = []
        for (const name of names) {
          const old = current.get(name)
          if (old === undefined) continue
          // From the gate on, a call to an old version's tool is refused at once.
          old.retired = removed.includes(name) ? plan.reason : "changed"
          olds.push(old)
        }
        // The sessions whose running turn now loses tools, as each session's latest Agent was built.
        const affected: Array<{
          readonly session: string
          readonly subagents: number
          readonly tasks: number
        }> = []
        if (olds.some((old) => old.contributions.toolkits.length > 0)) {
          for (const [session, agent] of agents) {
            if (Option.isSome(yield* agent.current.turn)) {
              affected.push({
                session,
                subagents: agent.subagents(),
                tasks: agent.tasks(),
              })
            }
          }
        }
        const closed = new Set<string>()
        const activated = new Set<string>()
        swapping = swap
        const steps = Effect.gen(function* () {
          const drained = yield* drain(olds)
          const spent = Math.max(
            0,
            drained.waited - Duration.toMillis(timings.swapDrain),
          )
          yield* close(
            olds,
            Duration.millis(
              Math.max(0, Duration.toMillis(timings.swapClose) - spent),
            ),
          )
          for (const old of olds) closed.add(old.name)
          for (const name of removed) {
            current.delete(name)
            previous.delete(name)
          }
          for (const { plugin } of built) {
            current.set(plugin.name, plugin)
            previous.delete(plugin.name)
            activated.add(plugin.name)
            yield* activate(plugin)
            yield* options.notices.clear(skippedKey(plugin.name))
          }
          generation++
          return {
            swapped: built.map(({ plugin }) => plugin.name),
            removed,
            ...drained,
            affected,
          }
        })
        // The apply runs the swap in a step nothing else cuts, so the steps are made interruptible here for the stop.
        return yield* Effect.withFiber((fiber) => {
          swap.fiber = fiber
          return Effect.interruptible(steps)
        }).pipe(
          // A graceful stop abandons the swap wherever it is. A new version that is not active is closed, an old one
          // that is not closed stays for the stop, and a plugin between the two has nothing left to run its queued
          // hooks, which are dropped with a log line.
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              for (const { plugin, dispose } of built) {
                if (activated.has(plugin.name)) continue
                if (closed.has(plugin.name)) current.delete(plugin.name)
                yield* dispose
              }
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (swapping === swap) swapping = undefined
              Deferred.doneUnsafe(gate, Exit.void)
              change()
            }),
          ),
        )
      })
      return {
        failed,
        built: built.map(({ plugin }) => plugin.name),
        settings: [...built]
          .sort((a, b) => byName(a.plugin, b.plugin))
          .map(({ plugin }) => ({
            name: plugin.name,
            items: plugin.recorder.items(),
            unread: plugin.recorder.unread(),
          })),
        replaceMe: built.flatMap(({ plugin }) =>
          plugin.contributions.toolkits.flatMap(({ toolkit }) =>
            Object.values(toolkit.tools)
              .filter(
                (tool) => tool.description?.startsWith("Replace me") === true,
              )
              .map((tool) => tool.name),
          ),
        ),
        swap,
        discard,
      }
    })

  // A graceful stop runs the queued hooks up to their deadline, a point in time from the stop's start, and only then
  // closes the plugins' scopes and their queues.
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
        // The stop's own line says what it dropped, and no notice goes for it.
        yield* Logger.event("stop.dropped", "The stop dropped queued hooks", {
          hooks: pending,
        })
      }
    }),
  )

  for (const entry of [...options.entries].sort(byName)) {
    const result = yield* build(entry, () => current.values())
    if (result._tag === "Built") {
      current.set(entry.name, result.plugin)
      yield* options.notices.clear(skippedKey(entry.name))
    } else {
      yield* skip(entry.name, result.error, entry.bundle !== undefined)
    }
  }
  for (const { name, message } of options.unloadable ?? []) {
    yield* skip(name, message, true)
  }
  for (const plugin of loaded()) yield* activate(plugin)
  yield* Deferred.succeed(ready, undefined)

  /**
   * The tools of a set of versions, each handler wrapped. The wrapper keeps the version the Agent is built on: once a
   * swap took that version out of service, a call fails at once with the refusal for why, and the handler does not
   * run. A call that a swap's drain cut fails with what happened to it.
   */
  const toolsOf = (
    versions: ReadonlyArray<Loaded>,
    current: CurrentSession["Service"] | undefined,
    subagents: () => number,
  ) => {
    const owned = versions.filter(
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
          const name = tool.name
          entries.set(tool.id, {
            ...handler,
            // A tool's log line goes to the calling script's output and to chad's log, under the plugin.
            handler: (params: unknown, options: unknown) =>
              Effect.suspend(() => {
                const retired = plugin.retired
                if (retired !== undefined) {
                  return Effect.die(
                    new Error(
                      Messages.toolRefused(retired, name, subagents() > 0),
                    ),
                  )
                }
                const called = handler
                  .handler(params, options)
                  .pipe(
                    current === undefined
                      ? (effect) => effect
                      : Effect.provideService(CurrentSession, current),
                    as(plugin),
                  ) as Effect.Effect<unknown, unknown>
                return track(plugin, "tool", name, called).pipe(
                  Effect.flatMap((outcome) =>
                    outcome._tag === "Ended"
                      ? outcome.exit
                      : Effect.die(
                          new Error(Messages.toolCut(name, outcome.stopped)),
                        ),
                  ),
                )
              }),
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

  const chunks: Plugins["Service"]["chunks"] = Effect.fnUntraced(
    function* (session) {
      const texts = new Map<string, string | undefined>()
      for (const plugin of loaded()) {
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
    },
  )

  const beforeTurn: Plugins["Service"]["beforeTurn"] = Effect.fnUntraced(
    function* (turn) {
      const texts: Array<{ readonly plugin: string; readonly text: string }> =
        []
      for (const plugin of loaded()) {
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
    },
  )

  /** Queues one call of each of a plugin's hooks of a kind, and gives a wait for each plugin's call. */
  const queued = Effect.fnUntraced(function* <A>(
    hook: "afterTurn" | "onSession",
    input: A,
    budget: Duration.Duration,
  ) {
    const waits: Array<Effect.Effect<void>> = []
    for (const plugin of loaded()) {
      const hooks = plugin.contributions[hook] as ReadonlyArray<
        Contributions.Hook<A, void>
      >
      if (hooks.length === 0) continue
      const done = Deferred.makeUnsafe<void>()
      waits.push(Deferred.await(done))
      yield* enqueue(plugin.name, { hook, input, budget, done })
    }
    // The wait is the value, which the caller runs when it chooses.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.all(waits, { concurrency: "unbounded", discard: true })
  })

  // A turn that starts while a swap runs waits for the activation, at most the drain and close deadlines.
  const waitSwap = Effect.suspend(() =>
    swapping === undefined
      ? Effect.void
      : Deferred.await(swapping.gate).pipe(
          Effect.timeoutOption(
            Duration.sum(timings.swapDrain, timings.swapClose),
          ),
          Effect.asVoid,
        ),
  )

  /** Answers a click or a submit with its plugin's handler, or with `unanswered` when no handler runs to an answer. */
  const interaction = <A>(unanswered: A) =>
    Effect.fnUntraced(function* (event: ChatInteraction.Interaction) {
      const held = () => {
        for (const plugin of current.values()) {
          const registered = plugin.contributions.interactions.find(
            ({ definition }) => definition.id === event.id,
          )
          if (registered !== undefined) return { plugin, registered }
        }
        return undefined
      }
      let found = held()
      // A swap that may change who holds the id runs to its end first, and the click goes to the version it leaves.
      const swap = swapping
      if (
        swap !== undefined &&
        (found === undefined || swap.names.has(found.plugin.name))
      ) {
        yield* Deferred.await(swap.gate)
        found = held()
      }
      if (found === undefined || found.plugin.retired !== undefined) {
        yield* Effect.logWarning("No plugin holds the id of a click").pipe(
          Effect.annotateLogs({ interaction: event.id }),
        )
        return unanswered
      }
      const { plugin, registered } = found
      const outcome = yield* track(
        plugin,
        "interaction",
        event.id,
        // Suspended, so a handler that throws before it returns its Effect fails here and is logged like any other.
        Effect.suspend(() => registered.handle(event)).pipe(
          as(plugin),
          Logger.ownConsole,
        ),
      )
      if (outcome._tag === "Cut") return unanswered
      if (Exit.isSuccess(outcome.exit)) return outcome.exit.value as A
      if (!Cause.hasInterruptsOnly(outcome.exit.cause)) {
        yield* Effect.logError(
          "A click handler of the plugin failed",
          outcome.exit.cause,
        ).pipe(
          Effect.annotateLogs({ interaction: event.id }),
          as(plugin),
          Logger.ownConsole,
        )
      }
      return unanswered
    })

  return Plugins.of({
    ready: Deferred.await(ready).pipe(Effect.andThen(waitSwap)),
    tools: (session, subagents = () => 0, tasks = () => 0) => {
      agents.set(session.session.id, { current: session, subagents, tasks })
      return toolsOf(loaded(), session, subagents)
    },
    chunks,
    beforeTurn,
    afterTurn: (ended) =>
      Effect.asVoid(queued("afterTurn", ended, timings.hookAfterTurn)),
    onSession: (event) => queued("onSession", event, timings.hookOnSession),
    status: () =>
      loaded().map((plugin) => {
        const mark = previous.get(plugin.name)
        return {
          name: plugin.name,
          counts: plugin.counts,
          ...(mark === undefined ? {} : { previous: mark }),
          settings: plugin.recorder.items(),
        }
      }),
    skipped: () => skipped,
    generation: () => generation,
    versions: () =>
      loaded().map((plugin) => ({
        name: plugin.name,
        hash: plugin.entry.bundle?.hash,
        entry: plugin.entry,
      })),
    prepare,
    abandon: Effect.suspend(() => {
      abandoned = true
      return swapping?.fiber === undefined
        ? Effect.void
        : Fiber.interrupt(swapping.fiber)
    }),
    active,
    whenActive,
    interactions: {
      click: interaction<ChatInteraction.ClickReply>(ChatInteraction.ack),
      submit: interaction<ChatInteraction.SubmitReply>(ChatInteraction.close),
    },
  })
})
