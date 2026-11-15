// PROTOTYPE plugin for TIM-552. A template: scenarios.ts keeps or drops the //#if blocks and fills the __NAMES__.
import { Plugin } from "chad"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const LABEL = "__LABEL__"

const Tools = Toolkit.make(
  //#if slow
  Tool.make("slow", {
    description: "Wait, then answer.",
    parameters: Schema.Struct({ ms: Schema.Number, tag: Schema.String }),
    success: Schema.String
  }),
  //#endif
  Tool.make("echo", {
    description: "__DESCRIPTION__",
    parameters: Schema.Struct({ text: Schema.String }),
    success: Schema.String
  })
)

export default Plugin.make(
  //#if afterTurn
  Plugin.afterTurn(Effect.gen(function*() {
    const ctx = yield* Plugin.PluginContext
    return (ended: any) =>
      ctx.log("afterTurn.start", { turn: ended.turn }).pipe(
        Effect.andThen(Effect.sleep(__AFTER_MS__)),
        Effect.andThen(ctx.log("afterTurn.end", { turn: ended.turn })),
        Effect.onInterrupt(() => ctx.log("afterTurn.interrupted", { turn: ended.turn }))
      )
  }), { timeout: __AFTER_TIMEOUT__ }),
  //#endif
  //#if background
  Plugin.background(Effect.gen(function*() {
    const ctx = yield* Plugin.PluginContext
    yield* ctx.log("background.start")
    return yield* Effect.never.pipe(Effect.onInterrupt(() => ctx.log("background.interrupted")))
  })),
  //#endif
  //#if compacted
  Plugin.onSession(Effect.gen(function*() {
    const ctx = yield* Plugin.PluginContext
    return (event: any) => ctx.log("compacted", { turn: event.turn })
  })),
  //#endif
  Plugin.toolkit(Tools, Effect.gen(function*() {
    const ctx = yield* Plugin.PluginContext
    // Something the plugin's scope owns. A handler that reaches it after the close dies loudly.
    const connection = yield* Effect.acquireRelease(
      Effect.sync(() => ({ open: true })),
      (c) =>
        Effect.sync(() => {
          c.open = false
        }).pipe(
          Effect.andThen(ctx.log("closing")),
          //#if hangClose
          Effect.andThen(Effect.never),
          //#endif
          Effect.andThen(Effect.void)
        )
    )
    const use = (tool: string, value: () => string) =>
      Effect.suspend(() => connection.open ? Effect.succeed(value()) : Effect.die(new Error("USED AFTER CLOSE: " + tool + " on instance " + ctx.instance)))
    const stamp = () => LABEL + " " + (ctx.settings.greeting ?? "hi") + " " + ctx.timezone + " #" + ctx.instance
    return {
      echo: ({ text }: { text: string }) => use("echo", () => stamp() + ": " + text),
      slow: ({ ms, tag }: { ms: number; tag: string }) =>
        ctx.log("slow.start", { tag }).pipe(
          Effect.andThen(Effect.sleep(ms)),
          Effect.andThen(use("slow", () => stamp() + ": slow " + tag)),
          Effect.tap(() => ctx.log("slow.end", { tag })),
          Effect.onInterrupt(() => ctx.log("slow.interrupted", { tag }))
        )
    }
  }))
)
