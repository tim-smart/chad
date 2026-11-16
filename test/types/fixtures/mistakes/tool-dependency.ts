// One of the six deliberate mistakes a plugin can make. It must fail to compile.
import { Context, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Plugin } from "chad"

/** The plugin's own service, which only the plugin can provide. */
class Notes extends Context.Service<Notes, { readonly text: string }>()(
  "fixture/Notes",
) {}

const Read = Tool.make("read", {
  description: "Reads the notes.",
  parameters: Schema.Struct({}),
  success: Schema.String,
  dependencies: [Notes],
})
const Kit = Toolkit.make(Read)

// A tool dependency that nobody provides.
export default Plugin.make(
  Plugin.toolkit(Kit).pipe(
    Layer.provide(
      Kit.toLayer({
        read: () =>
          Effect.gen(function* () {
            const { text } = yield* Notes
            return text
          }),
      }),
    ),
  ),
)
