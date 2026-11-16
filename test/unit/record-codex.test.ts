import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { afterEach, expect, it } from "vitest"
import { record } from "../../scripts/record-codex.ts"
import { httpClient, webSocketConstructor } from "../support/http.ts"
import {
  type FakeModel,
  refusalFrame,
  type Reply,
  responses,
  start,
} from "../support/model.ts"
import { load, shape, strip, stripped } from "../support/recording.ts"

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
  return { fake, out: join(dir, "codex-recording.json") }
}

/** The recorder on the fake's Codex side, through the test's host rewrite (TST-38), approving each device code. */
const recordOn = (fake: FakeModel, out: string, usageLimit = false) =>
  record({
    out,
    usageLimit,
    http: httpClient({ model: fake.url, discord: fake.url }),
    webSocket: webSocketConstructor(
      fake.socket,
      NodeSocket.layerWebSocketConstructor,
    ),
    onCode: () => fake.approve(),
    reconnect: "close",
  })

/** The replies of a full run, by call index: the answers first, then the refusals, which take an index each. */
const replies = (answer: string): ReadonlyArray<Reply> => [
  { text: answer },
  { text: answer },
  { tool: { name: "execute", arguments: { script: "console.log('hello')" } } },
  { text: "done" },
  { text: "1 2 3" },
  { text: "done" },
  { text: "one" },
  { text: "two" },
  { text: "hello" },
  ...Array.from({ length: 6 }, () => ({ text: "unused" })),
]

const limit = {
  type: "usage_limit_reached",
  message: "The usage limit has been reached",
  resets_at: 1_900_000_000,
}

it(
  "TST-216 TST-41 TST-40 the recorder runs each flow on the fake's Codex side and writes a stripped recording that the loader reads",
  { timeout: 20_000 },
  async () => {
    const { fake, out } = await setUp()
    fake.script(replies("Hello"))
    const outcome = await recordOn(fake, out)
    const refusedFlow = expect.stringMatching(/^refused: /)
    expect(outcome).toEqual({
      written: true,
      flows: {
        login: "logged in",
        answer: "answered",
        "answer-http": "answered",
        "tool-call": "answered",
        stop: "answered",
        reconnect: "answered",
        refresh: "answered",
        "refused-model": refusedFlow,
        "refused-model-http": refusedFlow,
        "max-output-tokens": refusedFlow,
        "max-output-tokens-http": refusedFlow,
        "expired-token": refusedFlow,
        "expired-token-http": refusedFlow,
      },
      missing: ["usage-limit"],
      leftover: [],
    })
    expect(fake.refreshed()).toHaveLength(1)

    const text = readFileSync(out, "utf8")
    for (const secret of [
      "fake-access-",
      "fake-refresh-",
      "FAKE-1",
      "device-1",
      "code-1",
    ]) {
      expect(text).not.toContain(secret)
    }
    const recording = load(out)
    expect(strip(recording)).toEqual(recording)
    expect(recording.opening.headers["authorization"]).toBe(stripped)
    expect(recording.opening.headers["session-id"]).toMatch(/^[0-9a-f-]{36}$/)
    expect(shape(recording.answer)).toEqual(
      shape(responses(0, { text: "Hello" }, "gpt-6-astra")),
    )
    const opened = (recording.flows?.["reconnect"]?.events ?? []).filter(
      (event) => "open" in event,
    )
    expect(opened).toHaveLength(2)

    // A run at the usage limit adds its frame to the same recording.
    fake.script([
      { status: 429, error: limit },
      { status: 429, error: limit },
    ])
    const limited = await recordOn(fake, out, true)
    expect(limited.written).toBe(true)
    expect(limited.missing).toEqual([])
    const merged = load(out)
    expect(shape(merged.refusal)).toEqual(
      shape(refusalFrame({ status: 429, error: limit })),
    )
    expect(merged.answer).toEqual(recording.answer)
  },
)

it(
  "TST-216 TST-41 the recorder writes nothing when a value of the login is left after stripping",
  { timeout: 20_000 },
  async () => {
    const { fake, out } = await setUp()
    // The model answers with the device code, which no field name marks as secret once it is in an answer's text.
    fake.script(replies("FAKE-1"))
    const outcome = await recordOn(fake, out)
    expect(outcome.written).toBe(false)
    expect(outcome.leftover).toContain("$.answer[2].delta")
    expect(existsSync(out)).toBe(false)
  },
)
