import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, onTestFinished, test } from "vitest"
import * as Logger from "../../src/daemon/Logger.ts"

test("FAIL-32 FAIL-33 the log is rotated between two lines once it passes its cap, chad.log.1 to chad.log.3 are kept, and the files joined oldest first end with every line written last, whole", () => {
  const directory = mkdtempSync(join(tmpdir(), "chad-log-"))
  onTestFinished(() => rmSync(directory, { recursive: true }))
  const path = join(directory, "chad.log")
  const sink = Logger.makeFileSink({ maxBytes: 200, keep: 3 })
  const written = Array.from({ length: 60 }, (_, index) =>
    JSON.stringify({ message: "line", index }),
  )
  // Lines written before the file is opened wait, and go first.
  sink.write(written[0]!)
  sink.open(path)
  for (const line of written.slice(1)) sink.write(line)

  const files = [`${path}.3`, `${path}.2`, `${path}.1`, path]
  expect(existsSync(`${path}.4`)).toBe(false)
  const texts = files.map((file) => readFileSync(file, "utf8"))
  for (const text of texts) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200)
    expect(text.endsWith("\n")).toBe(true)
  }
  const kept = texts.join("").split("\n").slice(0, -1)
  expect(kept).toEqual(written.slice(-kept.length))
  // The oldest lines were overwritten, and each of the four files holds some.
  expect(kept.length).toBeLessThan(written.length)
  expect(texts.every((text) => text.length > 0)).toBe(true)
})
