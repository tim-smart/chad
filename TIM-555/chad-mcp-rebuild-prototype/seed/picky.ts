// PROTOTYPE plugin for TIM-552. Fails to build on Mars, and when it has fewer than two owners.
import { Plugin } from "chad"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Tools = Toolkit.make(Tool.make("pick", { description: "Say which instance answers.", success: Schema.String }))

export default Plugin.make(
  Plugin.toolkit(Tools, Effect.gen(function*() {
    const ctx = yield* Plugin.PluginContext
    if (ctx.timezone === "Mars/Olympus") return yield* Effect.fail(new Error("unknown time zone Mars/Olympus"))
    if (ctx.owners.length < 2) return yield* Effect.fail(new Error("picky needs two owners"))
    return { pick: () => Effect.succeed("picky " + ctx.timezone + " owners=" + ctx.owners.join("+") + " #" + ctx.instance) }
  }))
)
