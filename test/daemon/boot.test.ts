import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test, vi } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { query } from "../support/database.ts"
import { fresh, scenario } from "../support/driver.ts"

/** What the daemon wrote to stdout, one entry for each line. */
const stdout = () => {
  const spy = vi.spyOn(process.stdout, "write")
  return () =>
    spy.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.startsWith("timestamp="))
}

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
