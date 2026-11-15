// PROTOTYPE for TIM-538. A fresh process that loads what live/ points at. No type-check, and a
// plugin that fails is skipped. Run after demo.ts or soak.ts: LOADER=bundle|esm node boot.ts
import { execFileSync } from "node:child_process"
import { LOADER, WORK, load, shutdown, state } from "./host.ts"

const commit = execFileSync("git", ["rev-parse", "refs/heads/applied"], { cwd: WORK, encoding: "utf8" }).trim()
const outcome = await load({ commit, check: false, tolerant: true })
console.log("boot with loader " + LOADER + ": loaded [" + outcome.reloaded.join(", ") + "]  ms " + JSON.stringify(outcome.ms))
for (const error of outcome.errors) console.log("  skipped: " + error.split("\n")[0])
console.log(await state())
await shutdown()
