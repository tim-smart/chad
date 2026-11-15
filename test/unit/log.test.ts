import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Fiber } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { followed } from "../../src/cli/commands/logs.ts"
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

/** Waits until `done` holds, for at most 5 s. */
const until = async (done: () => boolean) => {
  for (const deadline = Date.now() + 5000; !done();) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("FAIL-199 chad logs -f reads the files that rotations between two of its polls left, oldest first, before the newest, also when the file it read is no longer kept", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chad-follow-"))
  onTestFinished(() => rmSync(directory, { recursive: true }))
  const path = join(directory, "chad.log")
  const files = [`${path}.3`, `${path}.2`, `${path}.1`, path]
  // The sink's rotation: the oldest kept file is overwritten, and a new chad.log gets the next line.
  const rotate = (line: string) => {
    for (let index = 3; index >= 1; index--) {
      const from = index === 1 ? path : `${path}.${index - 1}`
      if (existsSync(from)) renameSync(from, `${path}.${index}`)
    }
    writeFileSync(path, line + "\n")
  }
  writeFileSync(path, "first\n")
  const printed: Array<string> = []
  const fiber = Effect.runFork(
    followed(
      files,
      (lines) => Effect.sync(() => void printed.push(...lines)),
      Infinity,
    ).pipe(Effect.provide(NodeServices.layer)),
  )
  onTestFinished(() => Effect.runPromise(Fiber.interrupt(fiber)))
  await until(() => printed.includes("first"))

  // Each burst runs in one go, so the follower polls only after it.
  rotate("middle")
  rotate("last")
  await until(() => printed.includes("last"))
  expect(printed).toEqual(["first", "middle", "last"])

  // Four rotations: the file the follower has open is no longer kept, so every kept file is newer.
  for (const line of ["one", "two", "three", "four"]) rotate(line)
  await until(() => printed.includes("four"))
  expect(printed).toEqual([
    "first",
    "middle",
    "last",
    "one",
    "two",
    "three",
    "four",
  ])
})
