import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, onTestFinished } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { chad, start } from "../support/cli.ts"
import { execute, query } from "../support/database.ts"

/** A volume of this test's own with a database that holds what the statements put there, and no daemon. */
const volume = (sql: string) => {
  const data = mkdtempSync(join(tmpdir(), "chad-db-"))
  onTestFinished(() => rmSync(data, { recursive: true, force: true }))
  mkdirSync(join(data, "db"))
  execute(data, sql)
  return data
}

/** `chad db` on the volume, as the owner types it. */
const db = (data: string, ...args: ReadonlyArray<string>) =>
  chad(["db", ...args], { CHAD_DATA: data })

/** A table of `count` rows, numbered from 1. */
const numbered = (count: number) => `
  CREATE TABLE numbers (n INTEGER PRIMARY KEY);
  WITH RECURSIVE counted (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counted WHERE n < ${count})
  INSERT INTO numbers SELECT n FROM counted
`

it("chad db query and chad db check answer beside a running daemon, beside one that SIGSTOP has frozen and with no daemon, so neither goes through the daemon or waits in its queue", async () => {
  const data = mkdtempSync(join(tmpdir(), "chad-db-"))
  onTestFinished(() => rmSync(data, { recursive: true, force: true }))
  const daemon = start(["serve"], { CHAD_DATA: data })
  onTestFinished(() => void daemon.child.kill("SIGKILL"))
  await daemon.printed("event=boot.ready")

  const count = ["query", "SELECT count(*) AS sessions FROM sessions"]
  const counted = { stdout: "sessions\n0\n", stderr: "", code: 0 }
  const sound = { stdout: "ok\n", stderr: "", code: 0 }
  expect(await db(data, ...count)).toEqual(counted)
  expect(await db(data, "check")).toEqual(sound)

  // A stopped process answers nothing on its socket and runs nothing from a queue.
  daemon.child.kill("SIGSTOP")
  expect(await db(data, ...count)).toEqual(counted)
  expect(await db(data, "check")).toEqual(sound)

  daemon.child.kill("SIGKILL")
  await daemon.done
  expect(await db(data, ...count)).toEqual(counted)
  expect(await db(data, "check")).toEqual(sound)
}, 30_000)

it("chad db query refuses a statement that writes, in the database or anywhere else, and still answers a PRAGMA that reads: a refusal exits 1 with SQLite's own message on stderr and nothing on stdout, as any statement that fails does, and a volume with no database is named", async () => {
  const data = volume(numbered(3))
  // What the read-only open does not cover: a file beside the database, a temporary table, an attached database and
  // the header of the temporary database.
  const copy = join(data, "copy.db")
  for (const [sql, message] of [
    [`VACUUM INTO '${copy}'`, "authorization denied"],
    ["CREATE TEMP TABLE more (n)", "not authorized"],
    [`ATTACH DATABASE '${copy}' AS more`, "not authorized"],
    ["PRAGMA temp.user_version = 42", "attempt to write a readonly database"],
  ] as const) {
    expect(await db(data, "query", sql), sql).toEqual({
      stdout: "",
      stderr: `${Messages.dbFailed("query", message)}\n`,
      code: 1,
    })
  }
  expect(existsSync(copy)).toBe(false)
  // A PRAGMA that reads takes an argument too, and is no write.
  expect(await db(data, "query", "PRAGMA table_info(numbers)")).toEqual({
    stdout:
      "cid\tname\ttype\tnotnull\tdflt_value\tpk\n0\tn\tINTEGER\t0\tNULL\t1\n",
    stderr: "",
    code: 0,
  })
  expect(await db(data, "query", "DELETE FROM numbers")).toEqual({
    stdout: "",
    stderr: `${Messages.dbFailed("query", "attempt to write a readonly database")}\n`,
    code: 1,
  })
  expect(query(data, "SELECT n FROM numbers")).toEqual([
    { n: 1n },
    { n: 2n },
    { n: 3n },
  ])
  expect(query(data, "SELECT name FROM sqlite_schema")).toEqual([
    { name: "numbers" },
  ])

  const empty = mkdtempSync(join(tmpdir(), "chad-db-"))
  onTestFinished(() => rmSync(empty, { recursive: true, force: true }))
  const path = join(empty, "db/chad.db")
  expect(await db(empty, "query", "SELECT 1")).toEqual({
    stdout: "",
    stderr: `${Messages.dbMissing("query", path)}\n`,
    code: 1,
  })
  expect(await db(empty, "check")).toEqual({
    stdout: "",
    stderr: `${Messages.dbMissing("check", path)}\n`,
    code: 1,
  })
  // A read creates nothing on the volume.
  expect(existsSync(join(empty, "db"))).toBe(false)
}, 20_000)
