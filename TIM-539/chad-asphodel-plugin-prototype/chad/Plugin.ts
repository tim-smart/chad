// PROTOTYPE for TIM-539, carried over from TIM-530. Throwaway.
// The signatures are the API agreed in TIM-530. Lines marked PROPOSED are
// changes this ticket asks for. They are not agreed.
//
// Unlike the TIM-530 version, the functions here have bodies. They write into
// a stand-in registry that `_host.ts` reads, so the plugin can be run. The
// bodies are not a design for chad's registry.
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import type { Chat } from "effect/chat"
import * as Context from "effect/Context"
import type * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import type * as KeyValueStore from "effect/persistence/KeyValueStore"
import type * as HttpClient from "effect/http/HttpClient"
import type { CurrentSession, Session, SessionEvent, Turn, TurnEnded } from "./Session.ts"
import type { Turns } from "./Turns.ts"

/**
 * A plugin file's default export is a Layer that provides nothing and needs
 * only what chad supplies. chad builds it once, in a scope of its own, when
 * the plugin is loaded. Unloading or reloading closes that scope.
 */
export type Plugin<E = unknown> = Layer.Layer<never, E, Services>

/** What chad supplies to a plugin's Layer. */
export type Services =
  | PluginContext
  | Turns
  | Chat.Chat
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  /** PROPOSED. The owner's timezone, set once in chad's own configuration. */
  | DateTime.CurrentTimeZone

/** `Layer.mergeAll`, plus a check that only chad's services are still needed. */
export const make = <
  Layers extends [Layer.Layer<never, any, Services>, ...Array<Layer.Layer<never, any, Services>>]
>(...layers: Layers): Plugin<Layer.Error<Layers[number]>> => Layer.mergeAll(...layers) as any

export class PluginContext extends Context.Service<
  PluginContext,
  {
    readonly name: string
    /** A key-value store in chad's SQLite file. Every key is under this plugin's name. */
    readonly store: KeyValueStore.KeyValueStore
    /**
     * PROPOSED. The ids allowed to trigger chad, as `<platform>:<id>`. Read
     * when the plugin loads. Changing the owners reloads the plugins.
     */
    readonly owners: ReadonlyArray<string>
  }
>()("chad/Plugin/PluginContext") {}

/** Adds a toolkit to every session's agent. The handlers come from `toolkit.toLayer`. */
export const toolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
): Layer.Layer<
  never,
  never,
  PluginContext | Tool.HandlersFor<Tools> | Exclude<Tool.HandlerServices<Tools[keyof Tools]>, CurrentSession>
> => contribute((registry, context) => registry.toolkits.push({ toolkit, context }))

export interface HookOptions {
  /**
   * How long chad waits for the hook. A hook that fails, dies or runs past its
   * budget is logged and skipped. The turn carries on without it.
   */
  readonly timeout?: Duration.Input | undefined
}

/**
 * A chunk appended to the system prompt. An empty string means no chunk.
 * Default budget 2s.
 *
 * Changed from the TIM-530 comment to match "Applying a plugin change to a
 * live session" (TIM-531): chad calls `render` before every turn and
 * compares the text with what the session last saw. A plugin whose chunk must
 * stay fixed for a session returns the same text for that session each time.
 *
 * PROPOSED. A render that fails or runs past its budget leaves the session
 * with the text it last saw. It does not count as the chunk being removed.
 */
export const prompt = <R = never>(
  render: (session: Session) => Effect.Effect<string, unknown, R>,
  options?: HookOptions
): Layer.Layer<never, never, PluginContext | R> =>
  contribute((registry, context) =>
    registry.prompts.push({ run: (session) => Effect.provide(render(session), context), timeout: options?.timeout ?? "2 seconds" })
  )

/**
 * Runs before each turn, on the reply path. A returned string is added to the
 * turn as context for the model. Default budget 5s.
 */
export const beforeTurn = <R = never>(
  hook: (turn: Turn) => Effect.Effect<string | void, unknown, R>,
  options?: HookOptions
): Layer.Layer<never, never, PluginContext | R> =>
  contribute((registry, context) =>
    registry.beforeTurn.push({ run: (turn) => Effect.provide(hook(turn), context), timeout: options?.timeout ?? "5 seconds" })
  )

/**
 * Runs after a turn ends, off the reply path. One plugin's calls run one at a
 * time, in the order the turns ended. Default budget 30s.
 */
export const afterTurn = <R = never>(
  hook: (ended: TurnEnded) => Effect.Effect<void, unknown, R>,
  options?: HookOptions
): Layer.Layer<never, never, PluginContext | R> =>
  contribute((registry, context) =>
    registry.afterTurn.push({ run: (ended) => Effect.provide(hook(ended), context), timeout: options?.timeout ?? "30 seconds" })
  )

/**
 * Runs when a session is reset or compacted. Queued with `afterTurn`.
 * Default budget 10s.
 */
export const onSession = <R = never>(
  hook: (event: SessionEvent) => Effect.Effect<void, unknown, R>,
  options?: HookOptions
): Layer.Layer<never, never, PluginContext | R> =>
  contribute((registry, context) =>
    registry.onSession.push({ run: (event) => Effect.provide(hook(event), context), timeout: options?.timeout ?? "10 seconds" })
  )

// -- the stand-in registry. Not part of the API. --------------------------------

interface Hook<A, B> {
  readonly run: (input: A) => Effect.Effect<B, unknown>
  readonly timeout: Duration.Input
}

export interface Registry {
  readonly toolkits: Array<{ readonly toolkit: Toolkit.Toolkit<any>; readonly context: Context.Context<any> }>
  readonly prompts: Array<Hook<Session, string>>
  readonly beforeTurn: Array<Hook<Turn, string | void>>
  readonly afterTurn: Array<Hook<TurnEnded, void>>
  readonly onSession: Array<Hook<SessionEvent, void>>
}

const registries = new WeakMap<object, Registry>()

/** For `_host.ts` only. */
export const registryOf = (plugin: PluginContext["Service"]): Registry => {
  let registry = registries.get(plugin)
  if (!registry) {
    registry = { toolkits: [], prompts: [], beforeTurn: [], afterTurn: [], onSession: [] }
    registries.set(plugin, registry)
  }
  return registry
}

const contribute = <R>(
  add: (registry: Registry, context: Context.Context<R>) => void
): Layer.Layer<never, never, PluginContext | R> =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const context = yield* Effect.context<PluginContext | R>()
      add(registryOf(Context.get(context, PluginContext)), context as Context.Context<R>)
    })
  )
