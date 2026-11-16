// One of the six deliberate mistakes of TST-22. It must fail to compile.
import { Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Plugin } from "chad"

const Roll = Tool.make("roll", {
  description: "Rolls a die.",
  parameters: Schema.Struct({}),
  success: Schema.Number,
})
const Dice = Toolkit.make(Roll)

// A toolkit with no handlers.
export default Plugin.make(Plugin.toolkit(Dice))
