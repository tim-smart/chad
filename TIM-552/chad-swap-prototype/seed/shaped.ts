// PROTOTYPE plugin for TIM-552. Its tool declarations are built from its settings, so the same
// bundle can render a different declaration, and the same declaration can hide a different schema.
import { Plugin } from "chad"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export default Plugin.make(Layer.unwrap(Effect.gen(function*() {
  const ctx = yield* Plugin.PluginContext
  const unit: string = ctx.settings.unit ?? "metres"
  const trim: boolean = ctx.settings.trim === true
  const min: number = ctx.settings.min ?? 0
  const max: number = ctx.settings.max ?? 5
  const Tools = Toolkit.make(
    Tool.make("measure", {
      description: "Measure a length in " + unit + ".",
      parameters: Schema.Struct({ value: Schema.Number }),
      success: Schema.String
    }),
    Tool.make("label", {
      description: "Store a label.",
      // Each of these renders as "readonly label: string".
      parameters: Schema.Struct({ label: (trim ? Schema.Trim : Schema.String).check(Schema.isMinLength(min)) }),
      success: Schema.String
    }),
    Tool.make("report", {
      description: "Write a report.",
      // The limit is in the result's schema and renders as "Promise<string>".
      success: Schema.String.check(Schema.isMaxLength(max))
    }),
    Tool.make("plain", { description: "Say which instance answers.", success: Schema.String })
  )
  return Plugin.toolkit(Tools, {
    measure: ({ value }: { value: number }) => Effect.succeed(value + " " + unit + " #" + ctx.instance),
    label: ({ label }: { label: string }) => Effect.succeed((trim ? "schema says trimmed" : "schema says as typed") + ", stored " + JSON.stringify(label) + " #" + ctx.instance),
    report: () => Effect.succeed("x".repeat(Math.min(max, 20))),
    plain: () => Effect.succeed("shaped #" + ctx.instance)
  })
})))
