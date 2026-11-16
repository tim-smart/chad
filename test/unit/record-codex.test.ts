import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { record } from "../../scripts/record-codex.ts"
import { type FakeModel, responses, start } from "../support/model.ts"
import { load, shapes, strip } from "../support/recording.ts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A fake model and a directory for the recording, both removed after the test. */
const setUp = async () => {
  const fake = await start()
  const dir = mkdtempSync(join(tmpdir(), "chad-record-"))
  cleanups.push(
    () => fake.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  )
  return { fake, out: join(dir, "codex-frames.json") }
}

/** The recorder on the fake, with one of the fake's tokens as the key: never a real endpoint or key. */
const recordOn = (fake: FakeModel, out: string, key: string) =>
  record({
    url: fake.url,
    key,
    model: "gpt-6-astra",
    socketUrl: fake.socket,
    out,
  })

it("TST-43 TST-41 the recorder records one answer on each transport and writes it stripped, with no trace of the key", async () => {
  const { fake, out } = await setUp()
  const key = fake.token().access
  fake.script([{ text: "Hello" }, { text: "Hello" }])
  const outcome = await recordOn(fake, out, key)
  expect(outcome).toEqual({
    written: true,
    calls: { http: "answered", socket: "answered" },
    leftover: [],
  })
  // Both calls carried the key, and the socket's opening request carried it as a header.
  expect(fake.calls().map((call) => call.headers["authorization"])).toEqual([
    `Bearer ${key}`,
    `Bearer ${key}`,
  ])
  expect(fake.calls()[1]?.body).toMatchObject({ model: "gpt-6-astra" })

  expect(readFileSync(out, "utf8")).not.toContain(key)
  const recording = load(out)
  expect(strip(recording)).toEqual(recording)
  const answer = shapes(responses(0, { text: "Hello" }, "gpt-6-astra"))
  expect(shapes(recording.answer.http)).toEqual(answer)
  expect(shapes(recording.answer.socket)).toEqual(answer)
})

it("TST-43 TST-41 the recorder writes nothing when the key is left after stripping", async () => {
  const { fake, out } = await setUp()
  const key = fake.token().access
  // The model answers with the key, which no field name marks as secret once it is in an answer's text.
  fake.script([{ text: key }, { text: key }])
  const outcome = await recordOn(fake, out, key)
  expect(outcome.written).toBe(false)
  expect(outcome.leftover).toContain("$.answer.http[4].delta")
  expect(existsSync(out)).toBe(false)
})
