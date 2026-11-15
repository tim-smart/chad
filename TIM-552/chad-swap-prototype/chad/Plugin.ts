// PROTOTYPE for TIM-552. Throwaway. A stand-in for chad's plugin API, shaped like the one agreed in
// "Plugin API: what a plugin exports and what it can do" (TIM-530) but smaller: handlers are passed
// to Plugin.toolkit directly, and there is no store, Config, Chat or prompt chunk.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"

const made = new WeakSet<object>()

export class PluginContext extends Context.Service<PluginContext, {
  readonly name: string
  /** Counts the instances of this plugin the daemon has built. Only the prototype needs it. */
  readonly instance: number
  readonly hash: string
  readonly settings: Record<string, any>
  readonly timezone: string
  readonly owners: ReadonlyArray<string>
  readonly log: (ev: string, data?: Record<string, unknown>) => Effect.Effect<void>
}>()("chad/PluginContext") {}

export type HookKind = "beforeTurn" | "afterTurn" | "Compacted"

/** Internal: where a plugin's contributions land. Provided per plugin instance by the host. */
export class Registry extends Context.Service<Registry, {
  readonly activated: Effect.Effect<void>
  readonly addToolkit: (toolkit: any, handlers: Record<string, (params: any) => Effect.Effect<any, any>>) => Effect.Effect<void>
  readonly addHook: (kind: HookKind, run: (payload: any) => Effect.Effect<any, any>, timeout: number | undefined) => Effect.Effect<void>
}>()("chad/internal/Registry") {}

type Services = PluginContext | Registry | Scope.Scope

/** Handlers may be built by an Effect, so they can close over something the plugin's scope owns. */
export const toolkit = (
  toolkit: any,
  handlers: Record<string, (params: any) => Effect.Effect<any, any>> | Effect.Effect<Record<string, (params: any) => Effect.Effect<any, any>>, any, Services>
) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const registry = yield* Registry
    yield* registry.addToolkit(toolkit, Effect.isEffect(handlers) ? yield* (handlers as any) : handlers)
  }))

const hook = (kind: HookKind) =>
(
  run: ((payload: any) => Effect.Effect<any, any>) | Effect.Effect<(payload: any) => Effect.Effect<any, any>, any, Services>,
  options?: { readonly timeout?: number }
) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const registry = yield* Registry
    yield* registry.addHook(kind, Effect.isEffect(run) ? yield* (run as any) : run, options?.timeout)
  }))

export const beforeTurn = hook("beforeTurn")
export const afterTurn = hook("afterTurn")
/** Only the Compacted event exists in the prototype. */
export const onSession = hook("Compacted")

/** Forked into the plugin's scope, started at activation. */
export const background = (effect: Effect.Effect<unknown, any, Services>) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const registry = yield* Registry
    yield* Effect.forkScoped(Effect.andThen(registry.activated, effect))
  }))

export const make = (...layers: Array<Layer.Layer<never, any, any>>) => {
  const layer = layers.length === 1 ? Layer.merge(layers[0], Layer.empty) : Layer.mergeAll(...(layers as [any, any]))
  made.add(layer)
  return layer
}

export const isPlugin = (u: unknown): boolean => typeof u === "object" && u !== null && made.has(u)
