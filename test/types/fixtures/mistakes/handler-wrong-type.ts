// One of the six deliberate mistakes of TST-22. It must fail to compile.
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Plugin } from "chad"

const Roll = Tool.make("roll", {
  description: "Rolls a die.",
  parameters: Schema.Struct({}),
  success: Schema.Number,
})
const Dice = Toolkit.make(Roll)

// A handler that returns the wrong type.
export default Plugin.make(
  Plugin.toolkit(Dice).pipe(
    Layer.provide(Dice.toLayer({ roll: () => Effect.succeed("six") })),
  ),
)
