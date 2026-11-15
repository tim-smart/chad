// PROTOTYPE plugin for TIM-552. A handler that cannot be interrupted.
import { Plugin } from "chad"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const LABEL = "__LABEL__"
const Tools = Toolkit.make(
  Tool.make("stuck", { description: "Wait where nothing can interrupt.", parameters: Schema.Struct({ ms: Schema.Number }), success: Schema.String }),
  Tool.make("ping", { description: "Say which instance answers.", success: Schema.String })
)

export default Plugin.make(
  Plugin.toolkit(Tools, Effect.gen(function*() {
    const ctx = yield* Plugin.PluginContext
    const connection = yield* Effect.acquireRelease(Effect.sync(() => ({ open: true })), (c) => Effect.sync(() => { c.open = false }))
    return {
      stuck: ({ ms }: { ms: number }) =>
        ctx.log("stuck.start").pipe(
          Effect.andThen(Effect.sleep(ms)),
          Effect.andThen(Effect.suspend(() => ctx.log("stuck.end", { connectionOpen: connection.open }))),
          Effect.as("done"),
          Effect.uninterruptible
        ),
      ping: () => Effect.succeed(LABEL + " #" + ctx.instance)
    }
  }))
)
