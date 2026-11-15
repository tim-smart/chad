// What the process driver knows of the processes a scenario started (TST-87). A session's background process leaves
// its daemon's process group and is handed to init when the daemon dies, and it may run with an environment it chose,
// so the driver keeps three records: every descendant of a daemon that the process table showed while the daemon
// lived, the process groups those descendants lead, and, where `/proc` exists, the mark each start's environment
// carries. It reads the table with `ps`, which Linux and macOS both have, and a table it cannot read fails the
// scenario rather than counting as empty.
import { execFile, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"

/** One line of the process table. */
interface Row {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly zombie: boolean
  /** When the process started, to the second, which tells a process from a later one that reuses its pid. */
  readonly started: number
}

const columns = ["-o", "pid=,ppid=,pgid=,stat=,lstart="]
const env = { ...process.env, LC_ALL: "C" }

const parse = (text: string): ReadonlyArray<Row> =>
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
const table = (): ReadonlyArray<Row> => {
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
  /** Counts a daemon's pid as a root of the scenario's processes. */
  readonly root: (pid: number) => void
  /** Records the descendants the process table shows now. A daemon's are read before it is killed. */
  readonly look: () => void
  /** Kills every recorded process and waits until none is left, failing after five seconds. */
  readonly reap: (wait: () => Promise<unknown>) => Promise<void>
}

export const tracker = (directory: string): Tracker => {
  // `lstart` is to the second and counts from the boot time, which drifts from the clock, so the bound is wide. It
  // only keeps a process older than the scenario, with a reused pid, out of the records.
  const since = Date.now() - 60_000
  const roots = new Set<number>()
  const known = new Map<number, number>()
  const groups = new Set<number>()
  let runner: number | undefined

  const take = (rows: ReadonlyArray<Row>, marks: ReadonlySet<number>) => {
    runner ??= rows.find((row) => row.pid === process.pid)?.pgid
    const children = new Map<number, Array<Row>>()
    for (const row of rows) {
      const list = children.get(row.ppid) ?? []
      list.push(row)
      children.set(row.ppid, list)
    }
    const queue = rows.filter(
      (row) =>
        row.started >= since &&
        (roots.has(row.pid) ||
          known.get(row.pid) === row.started ||
          groups.has(row.pgid) ||
          marks.has(row.pid)),
    )
    for (let row = queue.pop(); row !== undefined; row = queue.pop()) {
      if (row.pid === process.pid || row.started < since) continue
      known.set(row.pid, row.started)
      // The runner's own group is the daemons', and is never killed.
      if (row.pgid !== runner) groups.add(row.pgid)
      for (const child of children.get(row.pid) ?? []) {
        if (known.get(child.pid) !== child.started) queue.push(child)
      }
    }
  }

  // The table is read while the daemons run as well, for a parent that ends before a kill does.
  const poll = setInterval(() => {
    execFile(
      "ps",
      ["-A", ...columns],
      { encoding: "utf8", env },
      (error, out) => {
        if (error === null) take(parse(out), new Set())
      },
    )
  }, 250)
  poll.unref()

  return {
    root: (pid) => void roots.add(pid),
    look: () => take(table(), new Set()),
    reap: async (wait) => {
      clearInterval(poll)
      const left = Date.now() + 5_000
      for (;;) {
        const rows = table()
        take(rows, marked(directory))
        const living = rows.filter(
          (row) =>
            !row.zombie &&
            row.pid !== process.pid &&
            !roots.has(row.pid) &&
            (known.get(row.pid) === row.started ||
              (groups.has(row.pgid) && row.started >= since)),
        )
        if (living.length === 0) return
        if (Date.now() > left) {
          throw new Error(
            `processes outlived the scenario: ${living.map((row) => row.pid).join(", ")}`,
          )
        }
        for (const row of living) {
          try {
            process.kill(row.pid, "SIGKILL")
          } catch {
            // It ended in between.
          }
        }
        await wait()
      }
    },
  }
}
