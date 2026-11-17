// One of the six deliberate mistakes a plugin can make. It must fail to compile.
import { Effect } from "effect"
import { Plugin } from "chad"

// A hook that returns the wrong type.
export default Plugin.make(Plugin.prompt(() => Effect.succeed(6)))
