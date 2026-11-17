// What only a daemon in a process of its own shows: the lock it keeps for the life of the process, and the local
// platform's redelivery of an event that a killed daemon never acknowledged.
import { expect, test } from "vitest"
import { eventually } from "../support/owner.ts"
import { daemon } from "../support/process.ts"

test("a daemon started with --expose-gc that forces a collection every 200 milliseconds keeps its lock, and a second daemon on the same volume is refused and exits 1", async () => {
  const running = await daemon({ gc: true })
  await running.start()
  await eventually(running.collections, (count) => count >= 3)
  const second = running.spawn({ gc: false })
  expect((await second.exit).code).toBe(1)
  expect(running.output()).toContain("event=boot.refused reason=lock")
}, 15_000)
