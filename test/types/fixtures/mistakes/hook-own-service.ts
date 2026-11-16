// One of the six deliberate mistakes a plugin can make. It must fail to compile.
import { Context, Effect } from "effect"
import { Plugin } from "chad"

/** The plugin's own service, which only the plugin can provide. */
class Notes extends Context.Service<Notes, { readonly text: string }>()(
  "fixture/Notes",
) {}

// A hook that still needs the plugin's own service.
export default Plugin.make(
  Plugin.prompt(() =>
    Effect.gen(function* () {
      const { text } = yield* Notes
      return text
    }),
  ),
)
