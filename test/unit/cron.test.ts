// Cron next-run times in Pacific/Auckland across both daylight saving changes of 2026. The dates are real ones,
// because the source of effect's `Cron` warns that `next` near a gap is not guaranteed to be the nearest match.
import { expect, test } from "vitest"
import { next } from "../../src/daemon/Timers.ts"

const after = (cron: string, from: string) => {
  const result = next(cron, "Pacific/Auckland", Date.parse(from))
  if (result._tag === "Failure") throw new Error(result.failure)
  return new Date(result.success).toISOString()
}

test("a time in the hour that spring skips runs once, moved on by the gap, and a time in the hour that autumn repeats runs once, on its first occurrence", () => {
  // 27 September 2026: 02:00 NZST jumps to 03:00 NZDT, so 02:30 runs at 03:30 NZDT.
  expect(after("30 2 * * *", "2026-09-26T12:00:00Z")).toBe(
    "2026-09-26T14:30:00.000Z",
  )
  // The hour after the gap is there as usual.
  expect(after("0 * * * *", "2026-09-26T13:30:00Z")).toBe(
    "2026-09-26T14:00:00.000Z",
  )
  // 5 April 2026: 03:00 NZDT falls back to 02:00 NZST. 02:30 runs on its first occurrence, 13:30Z, and next on the
  // following day, not again an hour later.
  expect(after("30 2 * * *", "2026-04-04T12:00:00Z")).toBe(
    "2026-04-04T13:30:00.000Z",
  )
  expect(after("30 2 * * *", "2026-04-04T13:30:00Z")).toBe(
    "2026-04-05T14:30:00.000Z",
  )
  // An hourly job runs at 02:00 NZDT and next at 03:00 NZST, missing the repeated hour.
  expect(after("0 * * * *", "2026-04-04T13:00:00Z")).toBe(
    "2026-04-04T15:00:00.000Z",
  )
})
