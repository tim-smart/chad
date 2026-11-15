// PROTOTYPE for TIM-538. Walks the host through the cases the ticket asks about and prints the
// state after each one. Run: LOADER=bundle|esm node demo.ts
import * as fs from "node:fs"
import * as path from "node:path"
import { APP, LOADER, WORK, init, load, shutdown, state, timeline } from "./host.ts"

const edit = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(WORK, file)), { recursive: true })
  fs.writeFileSync(path.join(WORK, file), content)
}
const replace = (file: string, from: string, to: string) =>
  edit(file, fs.readFileSync(path.join(WORK, file), "utf8").replace(from, to))
const remove = (file: string) => fs.rmSync(path.join(WORK, file), { recursive: true, force: true })

const step = async (title: string, run: () => Promise<any>) => {
  console.log("\n=== " + title)
  const outcome = await run()
  if (outcome) {
    console.log(outcome.ok ? "  APPLIED" : "  REFUSED, nothing changed")
    if (outcome.ok) console.log("  reloaded [" + outcome.reloaded.join(", ") + "]  kept [" + outcome.kept.join(", ") + "]")
    console.log("  ms " + JSON.stringify(outcome.ms))
    for (const error of outcome.errors) console.log(error.split("\n").slice(0, 9).map((l: string) => "  | " + l).join("\n"))
  }
  console.log(await state())
}

console.log("loader: " + LOADER + "   node " + process.version)
init(path.join(APP, "..", "seed"))

await step("1. first apply", () => load({ message: "first apply" }))

await step("2. edit a file that dice.ts imports, apply", () => {
  replace("plugins/lib/faces.ts", "v1:", "v2:")
  return load({ message: "faces v2" })
})

await step("3. an edit that is not applied is a draft", async () => {
  replace("plugins/lib/faces.ts", "v2:", "v3 draft:")
})

await step("4. a type error blocks the apply", () => {
  replace("plugins/lib/faces.ts", "v3 draft:", "v3:")
  replace("plugins/dice.ts", "Effect.succeed(describeRoll(sides))", "Effect.succeed(describeRoll(sides).length)")
  return load({})
})

await step("5. a bare Layer without Plugin.make type-checks but is refused", () => {
  replace("plugins/dice.ts", "Effect.succeed(describeRoll(sides).length)", "Effect.succeed(describeRoll(sides))")
  edit("plugins/bare.ts", 'import * as Layer from "effect/Layer"\nexport default Layer.empty\n')
  return load({})
})

await step("6. a Layer that fails while building is refused, with a stack that names work/", () => {
  remove("plugins/bare.ts")
  edit("plugins/broken.ts", [
    'import { Plugin } from "chad"',
    'import * as Effect from "effect/Effect"',
    'import * as Layer from "effect/Layer"',
    "",
    "const connect = (): number => {",
    '  throw new Error("sidecar refused the connection")',
    "}",
    "",
    "export default Plugin.make(Layer.effectDiscard(Effect.sync(connect)))",
    ""
  ].join("\n"))
  return load({})
})

await step("7. a module that throws at import time is refused", () => {
  edit("plugins/broken.ts", 'import { Plugin } from "chad"\nconst config: { url: string } = JSON.parse("{oops")\nexport default Plugin.make()\nexport { config }\n')
  return load({})
})

await step("8. a tool name that chad already uses is refused", () => {
  remove("plugins/broken.ts")
  edit("plugins/clash.ts", [
    'import { Plugin } from "chad"',
    'import { Tool, Toolkit } from "effect/ai"',
    'import * as Effect from "effect/Effect"',
    'import * as Schema from "effect/Schema"',
    'const Clash = Toolkit.make(Tool.make("bash", { description: "x", success: Schema.String }))',
    'export default Plugin.make(Plugin.toolkit(Clash, { bash: () => Effect.succeed("hi") }))',
    ""
  ].join("\n"))
  return load({})
})

await step("9. a package that is not in the image fails the type-check", () => {
  remove("plugins/clash.ts")
  edit("plugins/extra.ts", 'import { Plugin } from "chad"\nimport * as lodash from "lodash"\nexport default Plugin.make()\nexport { lodash }\n')
  return load({})
})

await step("10. apply the v3 edit: only the plugin whose code changed is reloaded", () => {
  remove("plugins/extra.ts")
  return load({ message: "faces v3" })
})

console.log("\n=== 11. what the old and new copies of a plugin do during a swap (held open for 150ms)")
await new Promise((resolve) => setTimeout(resolve, 100))
timeline.length = 0
replace("plugins/ticker/label.ts", "tick A", "tick B")
const outcome = await load({ message: "ticker B", holdMs: 150 })
await new Promise((resolve) => setTimeout(resolve, 100))
console.log("  reloaded [" + outcome.reloaded.join(", ") + "]  kept [" + outcome.kept.join(", ") + "]")
console.log(timeline.map((line) => "  " + line).join("\n"))

await step("12. a plugin that uses top-level await and import.meta", () => {
  edit("plugins/tla.ts", [
    'import { Plugin } from "chad"',
    'import { Tool, Toolkit } from "effect/ai"',
    'import * as Effect from "effect/Effect"',
    'import * as Schema from "effect/Schema"',
    "const waited = await Promise.resolve(import.meta.url ?? \"(import.meta.url is empty)\")",
    'const Where = Toolkit.make(Tool.make("whereAmI", { description: "x", success: Schema.String }))',
    "export default Plugin.make(Plugin.toolkit(Where, { whereAmI: () => Effect.succeed(waited) }))",
    ""
  ].join("\n"))
  return load({})
})

await shutdown()
