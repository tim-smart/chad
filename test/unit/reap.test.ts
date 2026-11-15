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

describe("the driver's process records", () => {
  it("TST-87 a process that joined the group of a recorded one is killed after its parent has gone", async () => {
    const { tracked, killed } = watch([
      [daemon, row(200, 100, 200, 1_001)],
      [row(200, 1, 200, 1_001), row(201, 1, 200, 1_002)],
    ])
    tracked.root(100, () => true)
    tracked.look()
    await expect(tracked.reap(async () => {})).rejects.toThrow(
      "processes outlived the scenario: 200, 201",
    )
    expect(killed).toEqual([200, 201])
  })

  it("TST-87 a later process with a recorded pid, or in a group whose id a recorded process once had, is never killed", async () => {
    const { tracked, killed } = watch([
      [daemon, row(200, 100, 200, 1_001)],
      // 200 ended, and the pid and the group id came back to processes that are not the scenario's.
      [row(200, 1, 200, 9_000), row(300, 1, 200, 9_001)],
    ])
    tracked.root(100, () => true)
    tracked.look()
    await tracked.reap(async () => {})
    expect(killed).toEqual([])
  })

  it("TST-87 a root whose handle has ended is not taken for a later process with its pid", async () => {
    const { tracked, killed } = watch([
      [row(100, 1, 100, 9_000), row(400, 100, 400, 9_001)],
    ])
    tracked.root(100, () => false)
    tracked.look()
    await tracked.reap(async () => {})
    expect(killed).toEqual([])
  })

  it("TST-87 a poll's table that comes back after a newer look does not retire a process the look recorded", async () => {
    const ticks: Array<() => void> = []
    const pending: Array<(rows: ReadonlyArray<Row> | Error) => void> = []
    const tables: Array<ReadonlyArray<Row>> = [
      // The look before the kill sees the child.
      [daemon, row(200, 100, 200, 1_001)],
      // After the kill the child is init's, with the same pid, group and start time.
      [row(200, 1, 200, 1_001)],
    ]
    const killed: Array<number> = []
    const tracked = tracker("/nowhere", {
      bound: 0,
      kill: (pid) => void killed.push(pid),
      table: () => (tables.length > 1 ? tables.shift()! : tables[0]!),
      tableLater: (done) => void pending.push(done),
      poll: (tick) => (ticks.push(tick), () => {}),
    })
    tracked.root(100, () => true)
    // A poll starts while only the daemon runs, and its table comes back after the look.
    ticks[0]!()
    tracked.look()
    pending[0]!([daemon])
    await expect(tracked.reap(async () => {})).rejects.toThrow(
      "processes outlived the scenario: 200",
    )
    expect(killed).toEqual([200])
  })

  it("TST-87 a look that fails is not thrown at the caller, and the reap reports it", async () => {
    const { tracked } = watch([new Error("ps exited with 2")])
    tracked.root(100, () => true)
    expect(() => tracked.look()).not.toThrow()
    await expect(tracked.reap(async () => {})).rejects.toThrow(
      "ps exited with 2",
    )
  })
})
