import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test, vi } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { version } from "../../dist/Version.js"
import { query } from "../support/database.ts"
import { fresh, runs, scenario } from "../support/driver.ts"

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

/** What the daemon wrote to stdout, one entry for each line. */
const stdout = () => {
  const spy = vi.spyOn(process.stdout, "write")
  return () =>
    spy.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.startsWith("timestamp="))
}

test("a boot on an empty directory creates what is missing under CHAD_DATA, and leaves the umask and HOME alone", async () => {
  const umask = process.umask()
  const home = process.env["HOME"]
  const running = await scenario()
  const { data } = running
  await running.logged("boot.ready")

  for (const name of ["db", "secrets", "state", "run", "sessions", "logs"]) {
    const directory = statSync(join(data, name))
    expect(directory.isDirectory()).toBe(true)
    expect(directory.uid).toBe(process.getuid?.())
  }
  expect(mode(join(data, "secrets"))).toBe("700")
  expect(readFileSync(join(data, "state/version"), "utf8")).toBe(version + "\n")
  expect(process.umask()).toBe(umask)
  expect(process.env["HOME"]).toBe(home)
})

test("the database is one WAL file, and chad's tables come from Migrator before the boot is ready, strict and in the column conventions", async () => {
  const running = await scenario()
  const { data } = running
  const ready = await running.logged("boot.ready")
  const migrated = await running.logged("database.migrated")
  expect(Date.parse(migrated.timestamp)).toBeLessThanOrEqual(
    Date.parse(ready.timestamp),
  )

  expect(readdirSync(join(data, "db")).sort()).toEqual([
    "chad.db",
    "chad.db-shm",
    "chad.db-wal",
  ])
  expect(query(data, "PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }])
  expect(
    query(data, "SELECT migration_id, name FROM effect_sql_migrations"),
  ).toEqual([
    { migration_id: 1n, name: "sessions" },
    { migration_id: 2n, name: "turns" },
    { migration_id: 3n, name: "kills" },
    { migration_id: 4n, name: "updates" },
    { migration_id: 5n, name: "timers" },
  ])
  const [table] = query(
    data,
    "SELECT strict FROM pragma_table_list WHERE name = 'sessions'",
  )
  expect(table?.["strict"]).toBe(1n)
  const columns = query(
    data,
    "SELECT name, type FROM pragma_table_info('sessions')",
  )
  // A name is snake_case, a time is an integer and ends in _at, and JSON is TEXT.
  expect(columns).toEqual([
    { name: "id", type: "TEXT" },
    { name: "thread", type: "TEXT" },
    { name: "created_at", type: "INTEGER" },
    { name: "kind", type: "TEXT" },
    { name: "ended_at", type: "INTEGER" },
    { name: "environment", type: "TEXT" },
    { name: "system", type: "TEXT" },
    { name: "chunks", type: "TEXT" },
    { name: "generation", type: "INTEGER" },
    { name: "fingerprint", type: "TEXT" },
    { name: "last_message_id", type: "TEXT" },
    { name: "last_message_at", type: "INTEGER" },
    { name: "tasks", type: "TEXT" },
  ])
  // Cluster made its own tables, and no migration of chad's stands for them.
  const cluster = query(
    data,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cluster_messages'",
  )
  expect(cluster).toHaveLength(1)
})

test("the first open writes the shard count 1 in a chad_meta row that no migration creates", async () => {
  const running = await scenario()
  const { data } = running
  await running.logged("boot.ready")

  expect(query(data, "SELECT key, value FROM chad_meta")).toEqual([
    { key: "shards", value: "1" },
  ])
  expect(
    query(data, "SELECT name FROM pragma_table_info('chad_meta')").map(
      (column) => column["name"],
    ),
  ).toEqual(["key", "value"])
})

test("a database made with another shard count refuses the boot with exit 1, names both numbers in both sinks and changes nothing", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(join(data, "db"), { recursive: true })
  const database = new DatabaseSync(join(data, "db/chad.db"))
  database.exec(
    "CREATE TABLE chad_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO chad_meta VALUES ('shards', '2')",
  )
  database.close()
  const lines = stdout()

  const running = await scenario({ directory })
  expect(await running.exit).toBe(1)

  const refused = await running.logged("boot.refused")
  expect(refused.level).toBe("FATAL")
  expect(refused.message).toBe(Messages.shardCountChanged(2, 1))
  expect(refused.annotations).toMatchObject({ stored: 2, now: 1 })
  expect(
    lines().filter(
      (line) => line.includes("level=FATAL") && line.includes("boot.refused"),
    ),
  ).toHaveLength(1)
  // The guard ran before the migrations and before state/version is written.
  expect(
    query(data, "SELECT name FROM sqlite_master WHERE type = 'table'"),
  ).toEqual([{ name: "chad_meta" }])
  expect(query(data, "SELECT value FROM chad_meta")).toEqual([{ value: "2" }])
  expect(existsSync(join(data, "state/version"))).toBe(false)
})

test("every entry goes to both sinks, as effect's JSON line in the file and its logfmt line on stdout", async () => {
  const lines = stdout()
  const running = await scenario()
  const { data } = running
  await running.logged("boot.ready")
  await running.stop()

  const file = readFileSync(join(data, "logs/chad.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const fields = [
    "timestamp",
    "level",
    "message",
    "annotations",
    "spans",
    "fiberId",
  ]
  for (const entry of file) {
    expect(
      Object.keys(entry)
        .filter((key) => key !== "cause")
        .sort(),
    ).toEqual([...fields].sort())
  }
  const printed = lines()
  expect(printed).toHaveLength(file.length)
  file.forEach((entry, index) => {
    const line = printed[index]!
    expect(line.endsWith("\n")).toBe(true)
    expect(line.trimEnd()).not.toContain("\n")
    expect(line).toContain(`timestamp=${entry.timestamp} level=${entry.level}`)
    expect(line).toContain(`event=${entry.annotations.event}`)
  })
})

test("a CHAD_LOG_LEVEL that names no level writes a warning, and the boot goes on at info", async () => {
  const running = await scenario({ env: { CHAD_LOG_LEVEL: "loud" } })
  const unknown = await running.logged("boot.log-level-unknown")
  expect(unknown.level).toBe("WARN")
  expect(unknown.annotations["value"]).toBe("loud")
  const ready = await running.logged("boot.ready")
  expect(ready.level).toBe("INFO")
})

test("a volume the daemon cannot write refuses the boot with exit 1 and a message that names its uid and the owner, and nothing is written", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  chmodSync(data, 0o555)
  const lines = stdout()

  // Nothing can be stored on this volume, so the scenario adds no connection to it.
  const running = await scenario({ directory, connections: [] })
  expect(await running.exit).toBe(1)

  const self = { uid: process.getuid!(), gid: process.getgid!() }
  const message = Messages.dataNotWritable(data, self, { ...self, mode: "555" })
  // The template's own words are pinned by the unit suite. Here the message names the uid on both sides.
  expect(message.split(`uid ${self.uid}`).length).toBeGreaterThan(2)
  expect(lines().some((line) => line.includes(message))).toBe(true)
  expect(readdirSync(data)).toEqual([])
  chmodSync(data, 0o755)
})

test("the suites run in Pacific/Auckland, and the daemon sets no timezone of its own", async () => {
  expect(process.env["TZ"]).toBe("Pacific/Auckland")
  const running = await scenario()
  await running.logged("boot.ready")
  expect(process.env["TZ"]).toBe("Pacific/Auckland")
  expect([-720, -780]).toContain(new Date().getTimezoneOffset())
})

test("each scenario keeps its event log, the daemon's log and the database in a directory of its own, under the run id and a short path", async () => {
  const first = await scenario()
  await first.logged("boot.ready")
  await first.stop()
  const second = await scenario()
  await second.logged("boot.ready")

  expect(first.directory).not.toBe(second.directory)
  for (const { directory, data } of [first, second]) {
    expect(directory.startsWith(runs + "/")).toBe(true)
    expect(existsSync(join(directory, "events.jsonl"))).toBe(true)
    expect(existsSync(join(data, "logs/chad.log"))).toBe(true)
    expect(existsSync(join(data, "db/chad.db"))).toBe(true)
    // macOS holds the fewest bytes in a unix socket path.
    expect(Buffer.byteLength(join(data, "run/local.sock"))).toBeLessThan(103)
  }
  expect(runs).toBe(`/tmp/chad-${process.env["CHAD_TEST_RUN"]}`)
})
