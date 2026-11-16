import { Effect } from "effect"
import { expect, test } from "vitest"
import * as Disk from "../../dist/daemon/Disk.js"
import * as Notices from "../../dist/daemon/Notices.js"

test("the free space check raises disk-low below 1 GB, clears it at 1 GB or more, and changes nothing when it cannot read", async () => {
  const seen: Array<string> = []
  const condition: Disk.Condition = {
    raise: (notice) =>
      Effect.sync(() => void seen.push(`raise ${notice.text}`)),
    clear: (key) => Effect.sync(() => void seen.push(`clear ${key}`)),
  }
  const check = (free: Effect.Effect<number, unknown>) =>
    Effect.runPromise(Disk.check(free, condition))
  await check(Effect.succeed(Disk.threshold - 1))
  await check(Effect.succeed(Disk.threshold))
  await check(Effect.fail("statfs failed"))
  expect(seen).toEqual([
    `raise ${Notices.diskLow(Disk.threshold - 1).text}`,
    "clear disk-low",
  ])
})
