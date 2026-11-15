// What the process driver knows of the processes a scenario started. A session's background process leaves its
// daemon's process group and is handed to init when the daemon dies, and it may run with an environment it chose, so
// the driver records every descendant of a daemon that the process table shows while it can see one, with its start
// time, and reads the scenario's environment mark where `/proc` exists. It reads the table with `ps`, which Linux and
// macOS both have.
//
// A process counts as the scenario's only while the table shows it with the pid and the start time it was recorded
// with. A process group counts only while one of those processes is in it, because a group's id is not given to
// another group while a process is left in it, and a process that joined such a group is recorded too. A number alone
// is never taken as ownership. This is best effort: a background process whose parent ends between two looks, and
// which drops the mark or runs where `/proc` does not exist, is never seen (TST-87 is on the stopped list for it).
// A look that fails is kept and fails the scenario, and never stops a daemon's own handle from being signalled.
import { execFile, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"

/** One line of the process table. */
export interface Row {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly zombie: boolean
  /** When the process started, to the second, which tells a process from a later one that reuses its pid. */
  readonly started: number
}

const columns = ["-o", "pid=,ppid=,pgid=,stat=,lstart="]
const env = { ...process.env, LC_ALL: "C" }

export const parse = (text: string): ReadonlyArray<Row> =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [pid, ppid, pgid, stat, ...start] = line.trim().split(/\s+/)
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        zombie: (stat ?? "").startsWith("Z"),
        started: Date.parse(start.join(" ")),
      }
    })

/** The whole process table. */
export const table = (): ReadonlyArray<Row> => {
  const ran = spawnSync("ps", ["-A", ...columns], { encoding: "utf8", env })
  if (ran.error !== undefined || ran.status !== 0) {
    throw new Error(
      `ps could not read the process table: ${ran.error?.message ?? ran.stderr}`,
    )
  }
  return parse(ran.stdout)
}

/** Whether a process runs, which a zombie that waits to be reaped does not. A failed look is an error, not an answer. */
export const alive = (pid: number) => {
  const ran = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
    env,
  })
  if (ran.error !== undefined) throw ran.error
  if (ran.status === 0) return !ran.stdout.trim().startsWith("Z")
  if (ran.status === 1 && ran.stdout.trim() === "") return false
  throw new Error(`ps could not look at ${pid}: ${ran.stderr}`)
}

/** The variable that marks every process of one scenario with its directory. */
export const scenarioVariable = "CHAD_TEST_SCENARIO"

/** The processes whose environment carries the mark of the scenario in `directory`, where `/proc` shows it. */
const marked = (directory: string): ReadonlySet<number> => {
  if (!existsSync("/proc/self/environ")) return new Set()
  const mark = `${scenarioVariable}=${directory}`
  const found = new Set<number>()
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (
        readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(mark)
      ) {
        found.add(Number(name))
      }
    } catch {
      // It ended, or is another user's. The table and the groups still cover a process of the scenario's.
    }
  }
  return found
}

export interface Tracker {
  /** Counts a daemon as a root of the scenario's processes, while its own handle says it runs. */
  readonly root: (pid: number, running: () => boolean) => void
  /** Records the descendants the process table shows now. A failed look is kept for `reap`, and never thrown. */
  readonly look: () => void
  /**
   * Kills every recorded process that the table still shows as recorded, and waits until none is left. It fails with
   * every failed look once it is done, and when one outlives the bound.
   */
  readonly reap: (wait: () => Promise<unknown>) => Promise<void>
}

export interface Seams {
  readonly table?: () => ReadonlyArray<Row>
  /** Reads the table without blocking, for the poll. */
  readonly tableLater?: (
    done: (rows: ReadonlyArray<Row> | Error) => void,
  ) => void
  readonly kill?: (pid: number) => void
  /** Runs `tick`, which starts one read of the poll, on a schedule, and gives what stops it. `false` is no poll. */
  readonly poll?: false | ((tick: () => void) => () => void)
  readonly bound?: number
}

const tableLater = (done: (rows: ReadonlyArray<Row> | Error) => void) =>
  void execFile(
    "ps",
    ["-A", ...columns],
    { encoding: "utf8", env },
    (error, out) => done(error === null ? parse(out) : error),
  )

const every = (tick: () => void) => {
  const timer = setInterval(tick, 250)
  timer.unref()
  return () => clearInterval(timer)
}

const key = (row: Row) => `${row.pid}/${row.started}`

export const tracker = (directory: string, seams: Seams = {}): Tracker => {
  const read = seams.table ?? table
  const kill =
    seams.kill ?? ((pid: number) => void process.kill(pid, "SIGKILL"))
  const roots = new Map<
    number,
    { readonly running: () => boolean; started?: number }
  >()
  // Each recorded process, by its pid and start time.
  const known = new Set<string>()
  const failures: Array<string> = []

  const take = (rows: ReadonlyArray<Row>, marks: ReadonlySet<number>) => {
    const runner = rows.find((row) => row.pid === process.pid)?.pgid
    for (const row of rows) {
      const root = roots.get(row.pid)
      if (root !== undefined && root.started === undefined && root.running()) {
        root.started = row.started
      }
    }
    const ours = (row: Row) =>
      row.pid !== process.pid &&
      (known.has(key(row)) || roots.get(row.pid)?.started === row.started)
    for (const row of rows) if (marks.has(row.pid)) known.add(key(row))
    // To a fixed point: a child of one of ours, and a process in a group that one of ours is in, are ours.
    for (let grew = true; grew;) {
      grew = false
      const groups = new Set(
        rows
          .filter(ours)
          .map((row) => row.pgid)
          .filter((pgid) => pgid !== runner),
      )
      const parents = new Set(rows.filter(ours).map((row) => row.pid))
      for (const row of rows) {
        if (ours(row) || row.pid === process.pid) continue
        if (parents.has(row.ppid) || groups.has(row.pgid)) {
          known.add(key(row))
          grew = true
        }
      }
    }
    // A record the table no longer shows is retired, so a later process with its pid is not taken for it.
    const shown = new Set(rows.map(key))
    for (const entry of known) if (!shown.has(entry)) known.delete(entry)
  }

  // Each read takes a number when it starts, and a table is taken only when no later read was taken first. A poll's
  // table that comes back after a newer look would retire a process the look recorded while it is still there.
  let issued = 0
  let applied = 0
  const apply = (
    read: number,
    rows: ReadonlyArray<Row>,
    marks: ReadonlySet<number>,
  ) => {
    if (read <= applied) return
    applied = read
    take(rows, marks)
  }

  const look = () => {
    const number = ++issued
    try {
      apply(number, read(), new Set())
    } catch (error) {
      failures.push(String(error))
    }
  }

  // The table is read while the daemons run as well, for a parent that ends before a kill does.
  const later = seams.tableLater ?? tableLater
  const stop =
    seams.poll === false
      ? () => {}
      : (seams.poll ?? every)(() => {
          const number = ++issued
          later((rows) => {
            if (rows instanceof Error) failures.push(String(rows))
            else apply(number, rows, new Set())
          })
        })

  return {
    root: (pid, running) => void roots.set(pid, { running }),
    look,
    reap: async (wait) => {
      stop()
      const left = Date.now() + (seams.bound ?? 5_000)
      let living: ReadonlyArray<Row> = []
      try {
        for (;;) {
          let rows: ReadonlyArray<Row> | undefined
          const number = ++issued
          try {
            rows = read()
          } catch (error) {
            failures.push(String(error))
          }
          if (rows !== undefined) {
            apply(number, rows, marked(directory))
            living = rows.filter(
              (row) =>
                !row.zombie && !roots.has(row.pid) && known.has(key(row)),
            )
            if (living.length === 0) break
            for (const row of living) {
              try {
                kill(row.pid)
              } catch {
                // It ended in between.
              }
            }
          }
          if (Date.now() > left) break
          await wait()
        }
      } finally {
        stop()
      }
      const errors = failures.splice(0)
      if (living.length > 0) {
        errors.push(
          `processes outlived the scenario: ${living.map((row) => row.pid).join(", ")}`,
        )
      }
      if (errors.length > 0) throw new Error(errors.join("; "))
    },
  }
}
