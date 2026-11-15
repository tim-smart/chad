// PROTOTYPE for TIM-538: a one-tool plugin that imports a local file.
import { Plugin } from "chad"
import { Tool, Toolkit } from "effect/ai"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describeRoll } from "./lib/faces.ts"

const Dice = Toolkit.make(
  Tool.make("rollDice", {
    description: "Roll one die and say what it shows.",
    parameters: Schema.Struct({ sides: Schema.Int }),
    success: Schema.String
  }),
  // Returns the plugin's own Effect.gen so the host can compare it with its own.
  Tool.make("whichEffect", {
    description: "Prototype probe.",
    success: Schema.Unknown
  })
)

export default Plugin.make(
  Plugin.toolkit(Dice, {
    rollDice: ({ sides }) => Effect.succeed(describeRoll(sides)),
    whichEffect: () => Effect.succeed(Effect.gen)
  })
)
