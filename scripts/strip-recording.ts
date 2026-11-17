/**
 * Strips a raw recording of the Codex side, as `scripts/record-codex.ts --raw` keeps it, into the fake's recording:
 * `node scripts/strip-recording.ts <raw.json>` writes test/unit/fixtures/codex-frames.json. When
 * CLANKA_OPENAI_API_URL and CLANKA_OPENAI_API_KEY are set it also refuses to write while either, or a part of the host,
 * is left, and prints only where.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { hostParts, path } from "../test/support/recording.ts"
import { assemble, type Raw } from "./record-codex.ts"

const [input] = process.argv.slice(2)
if (input === undefined) {
  console.error("usage: node scripts/strip-recording.ts <raw.json>")
  process.exit(2)
}
const url = process.env["CLANKA_OPENAI_API_URL"]
const key = process.env["CLANKA_OPENAI_API_KEY"]
const secrets = [
  ...(key === undefined || key === "" ? [] : [key]),
  ...(url === undefined || url === "" ? [] : [url, ...hostParts(url)]),
]
const raw = JSON.parse(readFileSync(input, "utf8")) as Raw
const { recording, leftover } = assemble(raw, secrets)
if (leftover.length > 0) {
  console.error(`not written, a secret is left at: ${leftover.join(", ")}`)
  process.exit(1)
}
writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`)
console.log(`wrote ${path}`)
