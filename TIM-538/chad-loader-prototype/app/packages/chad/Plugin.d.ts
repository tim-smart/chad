import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import type { Tool, Toolkit } from "effect/ai"

declare const TypeId: unique symbol

export interface PluginContext {
  readonly name: string
  readonly version: string
  readonly log: (message: string) => Effect.Effect<void>
}
export declare const PluginContext: Context.Service<PluginContext, PluginContext>

export interface Turns {
  readonly start: (label: string) => Effect.Effect<void>
}
export declare const Turns: Context.Service<Turns, Turns>

export type Services = PluginContext | Turns

export interface Plugin<E = unknown> extends Layer.Layer<never, E, Services> {
  readonly [TypeId]: typeof TypeId
}

export declare const toolkit: <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Toolkit.HandlersFrom<Tools>
) => Layer.Layer<never, never, Services>

export declare const background: <E>(
  effect: Effect.Effect<unknown, E, Services | Scope.Scope>
) => Layer.Layer<never, never, Services>

export declare const make: <const Layers extends ReadonlyArray<Layer.Layer<never, any, Services>>>(
  ...layers: Layers
) => Plugin<Layer.Error<Layers[number]>>

export declare const isPlugin: (u: unknown) => u is Plugin
