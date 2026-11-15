/**
 * Strips a recording of the Codex side of its tokens and account id, so that it can be kept as the fake's recording
 * (TST-41, TST-43): `node scripts/strip-recording.ts <recording.json>` writes it to test/unit/fixtures/codex-frames.json.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { path, strip } from "../test/support/recording.ts"

const [input] = process.argv.slice(2)
if (input === undefined) {
  console.error("usage: node scripts/strip-recording.ts <recording.json>")
  process.exit(2)
}
const recording = strip(JSON.parse(readFileSync(input, "utf8")))
writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`)
console.log(`wrote ${path}`)
