// The driver's records of a scenario's processes (`test/support/reap.ts`), over a process table the test writes. A
// number alone is never ownership, and a failed look is kept and reported.
import { describe, expect, it } from "vitest"
import { type Row, tracker } from "../support/reap.ts"

const row = (
  pid: number,
  ppid: number,
  pgid: number,
  started: number,
): Row => ({
  pid,
  ppid,
  pgid,
  zombie: false,
  started,
})

const watch = (tables: Array<ReadonlyArray<Row> | Error>) => {
  const killed: Array<number> = []
  let last: ReadonlyArray<Row> = []
  const tracked = tracker("/nowhere", {
    poll: false,
    bound: 0,
    kill: (pid) => void killed.push(pid),
    table: () => {
      const next = tables.length > 1 ? tables.shift()! : tables[0]!
      if (next instanceof Error) throw next
      last = next
      return next
    },
  })
  return { tracked, killed, last: () => last }
}

const daemon = row(100, process.pid, process.pid, 1_000)

/** A tracker whose poll the test ticks, and whose reads in flight the test answers. */
const polled = (tables: Array<ReadonlyArray<Row>>) => {
  const ticks: Array<() => void> = []
  const pending: Array<(rows: ReadonlyArray<Row> | Error) => void> = []
  const killed: Array<number> = []
  const tracked = tracker("/nowhere", {
    bound: 0,
    kill: (pid) => void killed.push(pid),
    table: () => (tables.length > 1 ? tables.shift()! : tables[0]!),
    tableLater: (done) => void pending.push(done),
    poll: (tick) => (ticks.push(tick), () => {}),
  })
  return { tracked: { ...tracked, tick: () => ticks[0]!() }, pending, killed }
}

describe("the driver's process records", () => {
  it("a process that joined the group of a recorded one is killed after its parent has gone", async () => {
    const { tracked, killed } = watch([
      [daemon, row(200, 100, 200, 1_001)],
      [row(200, 1, 200, 1_001), row(201, 1, 200, 1_002)],
    ])
    tracked.root(100, () => true)
    await tracked.look()
    await expect(tracked.reap(async () => {})).rejects.toThrow(
      "processes outlived the scenario: 200, 201",
    )
    expect(killed).toEqual([200, 201])
  })

  it("a later process with a recorded pid, or in a group whose id a recorded process once had, is never killed", async () => {
    const { tracked, killed } = watch([
      [daemon, row(200, 100, 200, 1_001)],
      // 200 ended, and the pid and the group id came back to processes that are not the scenario's.
      [row(200, 1, 200, 9_000), row(300, 1, 200, 9_001)],
    ])
    tracked.root(100, () => true)
    await tracked.look()
    await tracked.reap(async () => {})
    expect(killed).toEqual([])
  })

  it("a recorded child that a newer look saw end is not brought back by an older table, so a later process with its pid in the same second is never killed", async () => {
    const { tracked, pending, killed } = polled([
      [daemon, row(200, 100, 200, 1_001)],
      // The child ended.
      [daemon],
      // Another process took its pid in the same second, which ps cannot tell apart.
      [daemon, row(200, 1, 200, 1_001)],
    ])
    tracked.root(100, () => true)
    await tracked.look()
    // A poll sampled while the child still ran, and its table comes back once the child has gone.
    tracked.tick()
    const looking = tracked.look()
    pending[0]!([daemon, row(200, 100, 200, 1_001)])
    await looking
    await tracked.reap(async () => {})
    expect(killed).toEqual([])
  })
})
