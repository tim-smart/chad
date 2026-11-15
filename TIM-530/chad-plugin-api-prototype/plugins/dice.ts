// PROTOTYPE for TIM-530. Throwaway example: the smallest plugin, one tool.
import { Plugin } from "chad"
import { Tool, Toolkit } from "effect/ai"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"

const Dice = Toolkit.make(
  Tool.make("rollDice", {
    description: "Roll one die and return the face it lands on.",
    parameters: Schema.Struct({ sides: Schema.Int }),
    success: Schema.Struct({ rolled: Schema.Int })
  })
)

export default Plugin.make(
  Plugin.toolkit(Dice).pipe(
    Layer.provide(Dice.toLayer({
      rollDice: ({ sides }) => Random.nextIntBetween(1, sides + 1).pipe(Effect.map((rolled) => ({ rolled })))
    }))
  )
)
