// PROTOTYPE for TIM-538: a directory plugin with two background fibers.
import { Plugin } from "chad"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { label } from "./label.ts"

export default Plugin.make(
  // Forked while the Layer builds, so it runs next to the old version until that one is closed.
  Layer.effectDiscard(Effect.gen(function*() {
    const context = yield* Plugin.PluginContext
    yield* Effect.forkScoped(
      context.log(`naive ${label}`).pipe(Effect.andThen(Effect.sleep("40 millis")), Effect.forever)
    )
  })),
  // Starts only after the old version has been closed.
  Plugin.background(Effect.gen(function*() {
    const context = yield* Plugin.PluginContext
    yield* context.log(`background ${label}`).pipe(Effect.andThen(Effect.sleep("40 millis")), Effect.forever)
  }))
)
