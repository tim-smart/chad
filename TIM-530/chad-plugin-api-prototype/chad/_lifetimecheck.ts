// PROTOTYPE for TIM-530. Throwaway. Runs against real effect, with a
// stand-in for chad's registry, to check two lifetime claims:
//   1. two contributions that each `Layer.provide` the same service share one
//      instance, and it stays open until the plugin's scope closes
//   2. the Effect shape's trap: `Effect.provide(layer)` around a plugin body
//      releases the service as soon as the body returns
// Run: node chad/_lifetimecheck.ts
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"

let builds = 0
class Own extends Context.Service<Own, { readonly state: Effect.Effect<string> }>()("Own") {
  static readonly layer = Layer.effect(
    Own,
    Effect.gen(function*() {
      builds++
      let open = true
      yield* Effect.addFinalizer(() => Effect.sync(() => { open = false }))
      return { state: Effect.sync(() => (open ? "open" : "closed")) }
    })
  )
}

// stand-in for Plugin.prompt: captures the context at build time
const hooks: Array<Effect.Effect<string>> = []
const register = <R>(hook: Effect.Effect<string, never, R>): Layer.Layer<never, never, R> =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const context = yield* Effect.context<R>()
      hooks.push(Effect.provide(hook, context))
    })
  )

const hook = Effect.flatMap(Own, (own) => own.state)
const plugin = Layer.mergeAll(
  register(hook).pipe(Layer.provide(Own.layer)),
  register(hook).pipe(Layer.provide(Own.layer))
)

const program = Effect.gen(function*() {
  const scope = yield* Scope.make()
  yield* Layer.buildWithScope(plugin, scope)
  console.log("layer shape: builds of Own =", builds)
  console.log("layer shape: hook after load =", yield* hooks[0]!, "/", yield* hooks[1]!)
  yield* Scope.close(scope, Exit.void)
  console.log("layer shape: hook after unload =", yield* hooks[0]!)

  const trapped: Array<Effect.Effect<string>> = []
  const pluginScope = yield* Scope.make()
  yield* Effect.gen(function*() {
    const own = yield* Own
    trapped.push(own.state)
  }).pipe(Effect.provide(Own.layer), Scope.provide(pluginScope))
  console.log("effect shape + Effect.provide: hook after load =", yield* trapped[0]!)
  yield* Scope.close(pluginScope, Exit.void)
})

Effect.runPromise(program)
