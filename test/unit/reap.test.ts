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

  it("a root whose handle has ended is not taken for a later process with its pid", async () => {
    const { tracked, killed } = watch([
      [row(100, 1, 100, 9_000), row(400, 100, 400, 9_001)],
    ])
    tracked.root(100, () => false)
    await tracked.look()
    await tracked.reap(async () => {})
    expect(killed).toEqual([])
  })

  it("a look waits for the poll's read in flight, so a table sampled before it never retires a process the look recorded", async () => {
    const { tracked, pending, killed } = polled([
      // The look sees the child, after the poll's table that does not.
      [daemon, row(200, 100, 200, 1_001)],
      // After the kill the child is init's, with the same pid, group and start time.
      [row(200, 1, 200, 1_001)],
    ])
    tracked.root(100, () => true)
    tracked.tick()
    const looking = tracked.look()
    pending[0]!([daemon])
    await looking
    await expect(tracked.reap(async () => {})).rejects.toThrow(
      "processes outlived the scenario: 200",
    )
    expect(killed).toEqual([200])
  })

  it("a child that only the poll's read in flight saw under its daemon is recorded before the look reads the table", async () => {
    const { tracked, pending, killed } = polled([
      // By the look the child has left the daemon's group and is init's.
      [daemon, row(300, 1, 300, 1_002)],
      [row(300, 1, 300, 1_002)],
    ])
    tracked.root(100, () => true)
    tracked.tick()
    const looking = tracked.look()
    pending[0]!([daemon, row(300, 100, 300, 1_002)])
    await looking
    await expect(tracked.reap(async () => {})).rejects.toThrow(
      "processes outlived the scenario: 300",
    )
    expect(killed).toEqual([300])
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

  it("the reap takes the poll's read in flight before it reads the table, so a child that read saw under its daemon is killed after the daemon has gone", async () => {
    let up = true
    const { tracked, pending, killed } = polled([
      [daemon],
      // The daemon has gone and its detached child is init's.
      [row(300, 1, 300, 1_002)],
    ])
    tracked.root(100, () => up)
    await tracked.look()
    tracked.tick()
    // A tick while a read is in flight starts no second one.
    tracked.tick()
    expect(pending).toHaveLength(1)
    up = false
    const reaping = tracked.reap(async () => {})
    pending[0]!([daemon, row(300, 100, 300, 1_002)])
    await expect(reaping).rejects.toThrow(
      "processes outlived the scenario: 300",
    )
    expect(killed).toEqual([300])
  })

  it("a poll's read that fails while the reap waits for it is reported, and the reap still kills what was recorded", async () => {
    const { tracked, pending, killed } = polled([
      [daemon, row(200, 100, 200, 1_001)],
      [row(200, 1, 200, 1_001)],
    ])
    tracked.root(100, () => true)
    await tracked.look()
    tracked.tick()
    const reaping = tracked.reap(async () => {})
    pending[0]!(new Error("ps timed out"))
    await expect(reaping).rejects.toThrow(
      /ps timed out.*processes outlived the scenario: 200/,
    )
    expect(killed).toEqual([200])
  })

  it("a look that fails is not thrown at the caller, and the reap reports it", async () => {
    const { tracked } = watch([new Error("ps exited with 2")])
    tracked.root(100, () => true)
    expect(() => tracked.look()).not.toThrow()
    await expect(tracked.reap(async () => {})).rejects.toThrow(
      "ps exited with 2",
    )
  })
})
