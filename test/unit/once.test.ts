// The mask the daemon puts in place of a value `requestOnce` gave a session, in a stream of that session's script
// output whose chunks split the value.
import { Duration, Effect } from "effect"
import { expect, it } from "vitest"
import * as Once from "../../src/daemon/Once.ts"

it("a value split across chunks of a session's output is masked, and another session's output is left alone", async () => {
  const value = "once-7c3e9a41d2"
  const once = Once.make(Duration.minutes(5))
  const request = once.open("local:t1", "s1")
  expect(once.submit(request.id, "local:t1", value)).toBe(true)
  expect(await Effect.runPromise(request.submitted)).toBe(value)

  const redactor = once.redactor("s1")
  const chunks = [
    "code: once-7c",
    "3e9a41d2 and once-7",
    "c3e9a41d2",
    " then once-7",
  ]
  const passed = [...chunks.map(redactor.push), redactor.end()]
  expect(passed.join("")).toBe(
    `code: ${Once.mask} and ${Once.mask} then once-7`,
  )
  for (const part of passed) expect(part).not.toContain(value)

  const other = once.redactor("s2")
  expect(other.push(value)).toBe(value)
})
