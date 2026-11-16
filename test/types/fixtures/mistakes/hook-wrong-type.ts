// One of the six deliberate mistakes of TST-22. It must fail to compile.
import { Effect } from "effect"
import { Plugin } from "chad"

// A hook that returns the wrong type.
export default Plugin.make(Plugin.prompt(() => Effect.succeed(6)))
