// plugins/<name>.ts, as written by `chad plugin new <name>`.
// <name> and <camelName> are filled in from the name given.
//
// Settings (under plugins.<name>.settings in chad.json):
//   greeting   string   default "Hello"
//
// Before changing this file, read the self-edit skill and
// /data/repo/node_modules/effect/AGENTS.md.
// Working plugins to read: /data/repo/examples/
// `chad check` type-checks it and loads it on trial. `chad apply -m "<why>"` makes it live.
import { Plugin } from "chad"
import { Config, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

// A tool the agent calls from its scripts. Replace it with your own.
// `chad check` reports and `chad apply` refuses a description that still starts with "Replace me".
const Tools = Toolkit.make(
  Tool.make("<camelName>Hello", {
    description: "Replace me. Say what the tool does and when to call it.",
    parameters: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ message: Schema.String })
  })
)

const ToolsLive = Plugin.toolkit(Tools).pipe(
  Layer.provide(Tools.toLayer(Effect.gen(function*() {
    // Runs once per load. Read settings and build clients here.
    const greeting = yield* Config.String("greeting").pipe(Config.withDefault("Hello"))
    return Tools.of({
      <camelName>Hello: ({ name }) => Effect.succeed({ message: `${greeting}, ${name}` })
    })
  })))
)

// Other contributions. Each returns a Layer to add to Plugin.make below.
//   Plugin.prompt((session) => ...)     a chunk of the system prompt
//   Plugin.beforeTurn((turn) => ...)    context added to one turn
//   Plugin.afterTurn((ended) => ...)    runs after a turn ends
//   Plugin.onSession((event) => ...)    a reset or a compaction
//   Plugin.background(effect)           a fiber for the plugin's whole life

export default Plugin.make(ToolsLive)
