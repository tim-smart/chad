// PROTOTYPE for TIM-538. Not the real API: see "Plugin API: what a plugin exports and what it can do" (TIM-530).
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

// Every Plugin.make result is remembered here. A second copy of this module has its own set,
// so isPlugin also proves that the plugin was built against the host's copy of chad.
const made = new WeakSet()

export const PluginContext = Context.Service("chad/PluginContext")
export const Turns = Context.Service("chad/Turns")
// Internal: where a plugin's contributions land. Provided per plugin instance by the host.
export const Registry = Context.Service("chad/internal/Registry")

export const toolkit = (toolkit, handlers) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const registry = yield* Registry
    yield* registry.addTools(Object.keys(toolkit.tools), handlers)
  }))

// Background work that must not run next to the previous version of the same plugin.
// It is forked into the plugin's scope but waits until the host activates this instance.
export const background = (effect) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const registry = yield* Registry
    yield* Effect.forkScoped(Effect.andThen(registry.activated, effect))
  }))

export const make = (...layers) => {
  const layer = Layer.mergeAll(...layers)
  made.add(layer)
  return layer
}

export const isPlugin = (u) => typeof u === "object" && u !== null && made.has(u)
