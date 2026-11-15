// PROTOTYPE plugin for TIM-552. v1 takes a number written as a string. v2 takes a string.
// "What an apply does to a plugin's work in flight" (TIM-547) found that both render the same JSON Schema.
import { Plugin } from "chad"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Tools = Toolkit.make(Tool.make("store", {
  description: "Store a value.",
  //#if v1
  parameters: Schema.Struct({ n: Schema.NumberFromString }),
  //#endif
  //#if v2
  parameters: Schema.Struct({ n: Schema.String }),
  //#endif
  success: Schema.String
}))

export default Plugin.make(
  Plugin.toolkit(Tools, {
    //#if v1
    store: ({ n }: { n: number }) => Effect.sync(() => "the v1 handler got a " + typeof n)
    //#endif
    //#if v2
    store: ({ n }: { n: string }) => Effect.sync(() => "the v2 handler, written for a string, got a " + typeof n + " and stored " + JSON.stringify(n + "0"))
    //#endif
  })
)
