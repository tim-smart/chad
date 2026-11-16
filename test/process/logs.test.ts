import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, onTestFinished, test } from "vitest"
import { start } from "../support/cli.ts"
import { fresh } from "../support/driver.ts"

const entry = (event: string) =>
  JSON.stringify({
    message: "m",
    level: "INFO",
    timestamp: "2026-11-15T09:12:44.120Z",
    annotations: { event },
    spans: {},
    fiberId: "#1",
  }) + "\n"

test("chad logs -f prints what the log holds and then each new entry, and keeps following when the file is rotated", async () => {
  const data = join(fresh(), "data")
  const logs = join(data, "logs")
  mkdirSync(logs, { recursive: true })
  const path = join(logs, "chad.log")
  writeFileSync(`${path}.1`, entry("test.rotated"))
  writeFileSync(path, entry("test.first"))
  const running = start(["logs", "-f"], { CHAD_DATA: data })
  onTestFinished(() => void running.child.kill())
  await running.printed("test.first")
  expect(running.output()).toContain("test.rotated")

  appendFileSync(path, entry("test.second"))
  await running.printed("test.second")
  // A line lands in the file just before it is renamed, and the next lines go to a new file.
  appendFileSync(path, entry("test.before-rotation"))
  renameSync(path, `${path}.1`)
  writeFileSync(path, entry("test.after-rotation"))
  await running.printed("test.after-rotation")
  appendFileSync(path, entry("test.third"))
  await running.printed("test.third")
  const order = [
    "test.rotated",
    "test.first",
    "test.second",
    "test.before-rotation",
    "test.after-rotation",
    "test.third",
  ].map((event) => running.output().indexOf(event))
  expect(order.every((at) => at >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
})
