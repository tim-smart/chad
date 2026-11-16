// One of the six deliberate mistakes of TST-22. It must fail to compile.
import { Context, Effect, Layer } from "effect"
import { Plugin } from "chad"

/** The plugin's own service, which only the plugin can provide. */
class Notes extends Context.Service<Notes, { readonly text: string }>()(
  "fixture/Notes",
) {}

// `Layer.provide` applied after `Plugin.make`.
export default Plugin.make(
  Plugin.prompt(() =>
    Effect.gen(function* () {
      const { text } = yield* Notes
      return text
    }),
  ),
).pipe(Layer.provide(Layer.succeed(Notes, { text: "kept" })))
