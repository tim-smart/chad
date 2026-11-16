/**
 * The file `chad plugin new` writes: a plugin with one tool and a setting, with the name filled in. It names the paths
 * under the repo the way the daemon does, which is `/data/repo` in the image.
 */

/**
 * The name's hyphen-separated parts joined in camel case, each part after the first with its first letter upper-cased.
 * A result that would be empty or start with a digit gets `plugin` in front, so the tool's name and the handler's key
 * are identifiers.
 */
export const camelName = (name: string): string => {
  const parts = name.split("-").filter((part) => part.length > 0)
  const joined = parts
    .map((part, index) =>
      index === 0 ? part : part[0]!.toUpperCase() + part.slice(1),
    )
    .join("")
  if (joined === "") return "plugin"
  return /^[0-9]/.test(joined)
    ? "plugin" + joined[0]!.toUpperCase() + joined.slice(1)
    : joined
}

/** The starter file for the plugin `name`, in the repo at `repo`. */
export const file = (options: {
  readonly name: string
  readonly repo: string
  readonly dir: boolean
}): string => {
  const camel = camelName(options.name)
  const path = options.dir
    ? `plugins/${options.name}/index.ts`
    : `plugins/${options.name}.ts`
  return `// ${path}, as written by \`chad plugin new ${options.name}${options.dir ? " --dir" : ""}\`.
//
// Settings (under plugins.${options.name}.settings in chad.json):
//   greeting   string   default "Hello"
//
// Before changing this file, read the self-edit skill and
// ${options.repo}/node_modules/effect/AGENTS.md.
// Working plugins to read: ${options.repo}/examples/
// \`chad check\` type-checks it and loads it on trial. \`chad apply -m "<why>"\` makes it live.
import { Plugin } from "chad"
import { Config, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

// A tool the agent calls from its scripts. Replace it with your own.
// \`chad check\` reports and \`chad apply\` refuses a description that still starts with "Replace me".
const Tools = Toolkit.make(
  Tool.make("${camel}Hello", {
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
      ${camel}Hello: ({ name }) => Effect.succeed({ message: \`\${greeting}, \${name}\` })
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
`
}
