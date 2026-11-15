// PROTOTYPE for TIM-538. Applies an edit N times and reports timings and memory.
// Run: LOADER=bundle|esm node --expose-gc soak.ts 300
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { APP, LOADER, WORK, finalized, init, load, shutdown, state } from "./host.ts"

const runs = Number(process.argv[2] ?? 300)
const checked = Number(process.argv[3] ?? 30) // how many of the runs also type-check
const gc = async () => {
  for (let i = 0; i < 4; i++) {
    ;(globalThis as any).Bun ? (globalThis as any).Bun.gc(true) : (globalThis as any).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const mb = (bytes: number) => Math.round(bytes / 1024 / 10.24) / 100
const TICK = String.fromCharCode(96)

// A plugin of a realistic size: 30 tools, about 250 lines, one imported file.
const big = (generation: number) => [
  'import { Plugin } from "chad"',
  'import { Tool, Toolkit } from "effect/ai"',
  'import * as Effect from "effect/Effect"',
  'import * as Schema from "effect/Schema"',
  'import { describeRoll } from "./lib/faces.ts"',
  "",
  "export const generation = " + generation,
  "",
  "const Big = Toolkit.make(",
  Array.from({ length: 30 }, (_, i) => [
    '  Tool.make("bigTool' + i + '", {',
    '    description: "Tool number ' + i + ' of a plugin that is about the size of a real one.",',
    "    parameters: Schema.Struct({ query: Schema.String, limit: Schema.Int, tags: Schema.Array(Schema.String) }),",
    "    success: Schema.Struct({ id: Schema.String, text: Schema.String, score: Schema.Finite })",
    "  })"
  ].join("\n")).join(",\n"),
  ")",
  "",
  "export default Plugin.make(",
  "  Plugin.toolkit(Big, {",
  Array.from({ length: 30 }, (_, i) =>
    "    bigTool" + i + ": ({ query, limit }) => Effect.succeed({ id: String(generation), text: describeRoll(limit) + query, score: " + i + " })"
  ).join(",\n"),
  "  })",
  ")",
  ""
].join("\n")

init(path.join(APP, "..", "seed"))
fs.writeFileSync(path.join(WORK, "plugins/big.ts"), big(0))
for (let i = 1; i <= 5; i++) {
  fs.writeFileSync(path.join(WORK, "plugins/big.ts"), big(-i))
  await load({ message: "warm up", check: false })
}
await gc()
const before = process.memoryUsage()
const finalizedBefore = finalized.modules
const totals: Record<string, Array<number>> = {}
let reloads = 0
for (let i = 1; i <= runs; i++) {
  fs.writeFileSync(path.join(WORK, "plugins/big.ts"), big(i))
  fs.writeFileSync(path.join(WORK, "plugins/lib/faces.ts"),
    "export const describeRoll = (sides: number): string => " + TICK + "run " + i + ": a $" + "{sides}-sided die shows 3" + TICK + "\n")
  const outcome = await load({ message: "soak " + i, check: i <= checked })
  if (!outcome.ok) throw new Error(outcome.errors.join("\n"))
  if (outcome.reloaded.length !== (LOADER === "esm" ? 3 : 2)) console.log("MISSED at apply " + i + ": reloaded [" + outcome.reloaded.join(", ") + "] kept [" + outcome.kept.join(", ") + "]")
  reloads += outcome.reloaded.length
  for (const [label, ms] of Object.entries(outcome.ms)) (totals[label] ??= []).push(ms)
}
await gc()
const after = process.memoryUsage()
const median = (values: Array<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

console.log("loader " + LOADER + "   runtime " + ((process.versions as any).bun ? "bun " + (process.versions as any).bun : "node " + process.version))
console.log(runs + " applies, " + reloads + " plugin reloads (big and dice change every time, ticker never does)")
console.log("median ms per apply: " + Object.entries(totals).map(([label, values]) => label + " " + median(values)).join(", "))
console.log("heap used: " + mb(before.heapUsed) + " MB -> " + mb(after.heapUsed) + " MB  ("
  + Math.round((after.heapUsed - before.heapUsed) / reloads / 102.4) / 10 + " KB per plugin reload)")
console.log("rss:       " + mb(before.rss) + " MB -> " + mb(after.rss) + " MB")
// esbuild does its work in a child process, so its memory is not in the rss above.
let children = ""
try { children = execFileSync("ps", ["-o", "rss=,comm=", "--ppid", String(process.pid)], { encoding: "utf8" }) } catch {}
console.log("child processes: " + (children.trim().split("\n").filter((l) => !l.includes("ps")).map((l) => {
  const [rss, name] = l.trim().split(/\s+/)
  return name + " " + mb(Number(rss) * 1024) + " MB"
}).join(", ") || "none"))
console.log("old plugin modules collected: " + (finalized.modules - finalizedBefore) + " of " + reloads)
console.log("versions/ entries on disk: " + fs.readdirSync(path.join(WORK, "..", "versions")).length)
console.log(await state())
await shutdown()
