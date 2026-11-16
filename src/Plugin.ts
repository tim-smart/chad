/**
 * What a plugin file exports, the functions that add to chad, and the services chad supplies.
 */
import {
  Context,
  type DateTime,
  Duration,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  Predicate,
  Scope,
} from "effect"
import type { Tool, Toolkit } from "effect/ai"
import type { Chat } from "effect/chat"
import type { HttpClient } from "effect/http"
import type { KeyValueStore } from "effect/persistence"
import * as Contributions from "./daemon/Contributions.ts"
import type {
  CurrentSession,
  Session,
  SessionEvent,
  Turn,
  TurnEnded,
} from "./Session.ts"
import type { Turns } from "./Turns.ts"

const TypeId: unique symbol = Symbol.for("chad/Plugin") as never

/**
 * A plugin file's default export is a Layer that provides nothing and needs
 * only what chad supplies. chad builds it once, in a scope of its own, when
 * the plugin is loaded. Unloading or reloading closes that scope.
 *
 * Only `make` returns one. The brand is what tells a `Plugin` from a bare
 * Layer that needs the same services.
 */
export interface Plugin<E = unknown> extends Layer.Layer<never, E, Services> {
  /** The brand that `make` puts on the value it returns. */
  readonly [TypeId]: typeof TypeId
}

/**
 * What chad supplies to a plugin's Layer. `DateTime.CurrentTimeZone` is the
 * owner's timezone. It is read when the plugin loads, and a change to it
 * reloads the plugins.
 */
export type Services =
  | PluginContext
  | Turns
  | Chat.Chat
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | DateTime.CurrentTimeZone

/**
 * `Layer.mergeAll`, plus a check that only chad's services are still needed.
 * A plugin provides its own services to its Layers before it calls `make`.
 * Providing them afterwards does not compile. The value it returns is
 * branded as a `Plugin`, in its type and at runtime.
 */
export const make = <
  Layers extends [
    Layer.Layer<never, unknown, Services>,
    ...Array<Layer.Layer<never, unknown, Services>>,
  ],
>(
  ...layers: Layers
): Plugin<Layer.Error<Layers[number]>> => {
  const merged = Layer.mergeAll(...layers)
  // A copy carries the brand, so a Layer that `make` was given stays unbranded.
  const branded = Object.create(
    Object.getPrototypeOf(merged),
    Object.getOwnPropertyDescriptors(merged),
  )
  Object.defineProperty(branded, TypeId, { value: TypeId })
  return branded
}

/**
 * True only for a value that `make` returned. chad's check before a load
 * uses it to refuse a file whose default export is a bare Layer.
 */
export const isPlugin = (u: unknown): u is Plugin =>
  Predicate.hasProperty(u, TypeId)

/**
 * The plugin's own name, store and owner ids. Settings are not here. A plugin
 * reads them with Effect's `Config`, which sees only this plugin's
 * `settings` object in `chad.json`.
 */
export class PluginContext extends Context.Service<
  PluginContext,
  {
    /** The plugin's name, which is its file or directory name under `plugins/`. */
    readonly name: string
    /**
     * A key-value store in chad's SQLite file that only this plugin can see.
     * It has no expiry, so a plugin prunes its own keys.
     */
    readonly store: KeyValueStore.KeyValueStore
    /**
     * The ids allowed to trigger chad, as `<platform>:<id>`. Read when the
     * plugin loads. Changing the owners reloads the plugins.
     */
    readonly owners: ReadonlyArray<string>
  }
>()("chad/Plugin/PluginContext") {}

/** Where a contribution puts itself, which is the plugin's own load. */
const contributions = Effect.gen(function* () {
  return Contributions.of(yield* PluginContext)
})

/** Options every hook takes. */
export interface HookOptions {
  /**
   * How long chad waits for the hook. A hook that fails, dies or runs past its
   * budget is logged and skipped. The turn carries on without it. While chad
   * swaps plugin versions, a hook still running 30 seconds into the swap is
   * interrupted whatever this says.
   */
  readonly timeout?: Duration.Input | undefined
}

const budget = (options: HookOptions | undefined) =>
  options?.timeout === undefined
    ? undefined
    : Duration.fromInputUnsafe(options.timeout)

/** Registers one hook, run later with the services its Layer was built with. */
const hook = <A, B, R>(
  pick: (into: Contributions.Contributions) => Array<Contributions.Hook<A, B>>,
  run: (input: A) => Effect.Effect<B, unknown, R>,
  options: HookOptions | undefined,
): Layer.Layer<never, never, PluginContext | R> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const into = yield* contributions
      const context = yield* Effect.context<R>()
      pick(into).push({
        run: (input) => Effect.provideContext(run(input), context),
        timeout: budget(options),
      })
    }),
  )

/**
 * Adds a toolkit to every session's agent. The handlers come from
 * `toolkit.toLayer`. A tool lists `Session.CurrentSession` in its
 * `dependencies` to learn its session and turn, and any other dependency
 * comes from the plugin's own Layers. A tool name that another plugin or
 * clanka already uses fails the load.
 */
export const toolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Layer.Layer<
  never,
  never,
  | PluginContext
  | Tool.HandlersFor<Tools>
  | Exclude<Tool.HandlerServices<Tools[keyof Tools]>, CurrentSession>
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const into = yield* contributions
      const context = yield* Effect.context<never>()
      into.toolkits.push({ toolkit, context })
    }),
  )

/**
 * A chunk appended to the system prompt. An empty string means no chunk.
 * Default budget 2s.
 *
 * chad calls `render` before every turn and compares the text with what the
 * session last saw. A plugin whose chunk must stay fixed for a session keeps
 * the text in its store and returns what it kept.
 *
 * A render that fails or runs past its budget leaves the session with the
 * text it last saw. It does not count as the chunk being removed.
 */
export const prompt = <R = never>(
  render: (session: Session) => Effect.Effect<string, unknown, R>,
  options?: HookOptions,
): Layer.Layer<never, never, PluginContext | R> =>
  hook((into) => into.prompts, render, options)

/**
 * Runs when a turn starts, on the reply path, and not for a message that
 * steers a running turn. A returned string is added to the turn as context
 * for the model and stays in the history until a compaction. Runs again for a
 * turn that is resumed after a restart. Default budget 5s.
 */
export const beforeTurn = <R = never>(
  hook_: (turn: Turn) => Effect.Effect<string | void, unknown, R>,
  options?: HookOptions,
): Layer.Layer<never, never, PluginContext | R> =>
  hook((into) => into.beforeTurn, hook_, options)

/**
 * Runs after a turn ends, off the reply path, once per turn. One plugin's
 * calls run one at a time, in the order the turns ended. Default budget 30s.
 *
 * It is not durable. A turn that ends as chad is killed never reaches it. A
 * reload can happen between a tool call or `beforeTurn` and this hook, so
 * what must survive until here goes in the store and not in memory.
 */
export const afterTurn = <R = never>(
  hook_: (ended: TurnEnded) => Effect.Effect<void, unknown, R>,
  options?: HookOptions,
): Layer.Layer<never, never, PluginContext | R> =>
  hook((into) => into.afterTurn, hook_, options)

/**
 * Runs when a session is reset or compacted. Queued with `afterTurn`.
 * Default budget 10s.
 *
 * A `Reset` hook has run or timed out before the new session's first
 * `beforeTurn`.
 */
export const onSession = <R = never>(
  hook_: (event: SessionEvent) => Effect.Effect<void, unknown, R>,
  options?: HookOptions,
): Layer.Layer<never, never, PluginContext | R> =>
  hook((into) => into.onSession, hook_, options)

/**
 * Forks `effect` into the plugin's scope as a fiber for the plugin's whole
 * life. The fiber starts only when chad activates this version, which is
 * after the previous version's scope has closed, and it is interrupted when
 * this version is unloaded. A fiber forked directly while the Layer builds
 * runs next to the previous version's for a moment after a reload.
 *
 * A fiber that fails or dies is logged as one error under the plugin's name
 * and is not started again, so a fiber that must keep running retries
 * itself. A fiber that returns is not an error and is not started again.
 */
export const background = <E, R = never>(
  effect: Effect.Effect<unknown, E, R>,
): Layer.Layer<never, never, PluginContext | Exclude<R, Scope.Scope>> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const into = yield* contributions
      const context = yield* Effect.context<Exclude<R, Scope.Scope>>()
      into.background.push((scope) =>
        Effect.provideContext(
          effect as Effect.Effect<
            unknown,
            E,
            Exclude<R, Scope.Scope> | Scope.Scope
          >,
          Context.add(context, Scope.Scope, scope),
        ),
      )
    }),
  )
