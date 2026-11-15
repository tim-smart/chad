// PROTOTYPE for TIM-538. What each bundler does with import.meta in CJS output.
import * as esbuild from "esbuild"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as rolldown from "rolldown"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chad-import-meta-"))
const file = path.join(dir, "probe.ts")
fs.writeFileSync(file, "export const url: string = import.meta.url\nexport const dirname: string = import.meta.dirname\n")
const e = await esbuild.build({ entryPoints: [file], bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent" })
console.log("esbuild warnings: " + e.warnings.map((w) => w.text).join(" | "))
console.log(e.outputFiles[0].text.split("\n").filter((l) => /url|dirname|import_meta/.test(l)).join("\n"))
const r = await rolldown.build({ input: file, write: false, platform: "node", logLevel: "silent", output: { format: "cjs", exports: "named" } })
console.log("rolldown:")
console.log(r.output[0].code.split("\n").filter((l) => /url|dirname/.test(l)).join("\n"))
fs.rmSync(dir, { recursive: true, force: true })
