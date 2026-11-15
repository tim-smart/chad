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

it("STO-80 CLI-31f CLI-130 CLI-131 chad db query and chad db check answer beside a running daemon, beside one that SIGSTOP has frozen and with no daemon, so neither goes through the daemon or waits in its queue", async () => {
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

it("STO-79 STO-175 STO-202 chad db query refuses a statement that writes, in the database or anywhere else, and still answers a PRAGMA that reads: a refusal exits 1 with SQLite's own message on stderr and nothing on stdout, as any statement that fails does, and a volume with no database is named", async () => {
  const data = volume(numbered(3))
  // What the read-only open does not cover: a file beside the database, a temporary table, an attached database and
  // the header of the temporary database.
  const copy = join(data, "copy.db")
  for (const [sql, message] of [
    [`VACUUM INTO '${copy}'`, "authorization denied"],
    ["VACUUM", "authorization denied"],
    ["CREATE TEMP TABLE more (n)", "not authorized"],
    [`ATTACH DATABASE '${copy}' AS more`, "not authorized"],
    ["PRAGMA temp.user_version = 42", "attempt to write a readonly database"],
    ["PRAGMA temp.application_id = 42", "attempt to write a readonly database"],
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
  expect(await db(data, "query", "PRAGMA temp.user_version")).toEqual({
    stdout: "user_version\n0\n",
    stderr: "",
    code: 0,
  })
  for (const sql of [
    "DELETE FROM numbers",
    "INSERT INTO numbers VALUES (4)",
    "UPDATE numbers SET n = n + 10",
    "DROP TABLE numbers",
    "CREATE TABLE more (n)",
  ]) {
    expect(await db(data, "query", sql), sql).toEqual({
      stdout: "",
      stderr: `${Messages.dbFailed("query", "attempt to write a readonly database")}\n`,
      code: 1,
    })
  }
  expect(query(data, "SELECT n FROM numbers")).toEqual([
    { n: 1n },
    { n: 2n },
    { n: 3n },
  ])
  expect(query(data, "SELECT name FROM sqlite_schema")).toEqual([
    { name: "numbers" },
  ])

  expect(await db(data, "query", "SELECT n FROM nowhere")).toEqual({
    stdout: "",
    stderr: `${Messages.dbFailed("query", "no such table: nowhere")}\n`,
    code: 1,
  })

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

it("STO-81 STO-201 CLI-130 chad db query prints at most 200 rows, or as many as --limit gives, says on stderr when the statement had more, and takes no --limit below 1", async () => {
  const data = volume(numbered(250))
  const lines = (stdout: string) => stdout.split("\n").slice(1, -1)
  const all = "SELECT n FROM numbers ORDER BY n"

  const capped = await db(data, "query", all)
  expect(lines(capped.stdout)).toHaveLength(200)
  expect(lines(capped.stdout).at(-1)).toBe("200")
  expect(capped.stderr).toBe(`${Messages.dbMore(200)}\n`)
  expect(capped.code).toBe(0)

  const raised = await db(data, "query", all, "--limit", "1000")
  expect(lines(raised.stdout)).toHaveLength(250)
  expect(raised.stderr).toBe("")

  const lowered = await db(data, "query", "--limit", "3", all)
  expect(lowered).toEqual({
    stdout: "n\n1\n2\n3\n",
    stderr: `${Messages.dbMore(3)}\n`,
    code: 0,
  })

  // A statement with exactly as many rows as the limit has no more.
  const exact = await db(data, "query", "--limit", "250", all)
  expect(lines(exact.stdout)).toHaveLength(250)
  expect(exact.stderr).toBe("")

  for (const limit of ["0", "-1", "1.5", "many"]) {
    const refused = await db(data, "query", all, "--limit", limit)
    expect(refused.code, limit).toBe(2)
    expect(refused.stdout).toMatch(/USAGE\n {2}chad db query /)
  }
  expect((await db(data, "query", all, "--limit", "0")).stderr).toContain(
    Messages.dbLimit(),
  )
})

const mixed = `
  CREATE TABLE mixed ("na\tme" TEXT, number, bytes BLOB);
  INSERT INTO mixed VALUES
    ('one' || char(9) || 'tab', 1.5, x'00ff'),
    ('two' || char(10) || 'lines', NULL, x''),
    ('a\\back' || char(92) || 'n', 9007199254740993, NULL),
    ('', 7, NULL)
`

it("STO-172 STO-173 STO-200 without --json chad db query prints a header line and one line for each row, with tabs between the values, and a tab, a newline and a backslash escaped so that a row is one line", async () => {
  const data = volume(mixed)
  expect(await db(data, "query", "SELECT * FROM mixed ORDER BY rowid")).toEqual(
    {
      stdout: [
        "na\\tme\tnumber\tbytes",
        "one\\ttab\t1.5\tx'00ff'",
        "two\\nlines\tNULL\tx''",
        "a\\\\back\\\\n\t9007199254740993\tNULL",
        "\t7\tNULL",
        "",
      ].join("\n"),
      stderr: "",
      code: 0,
    },
  )
  // A statement with no rows prints its header.
  expect(
    (await db(data, "query", "SELECT number FROM mixed WHERE 0")).stdout,
  ).toBe("number\n")
})

it("STO-81 CLI-46e STO-199 with --json chad db query prints one line that holds an array with an object for each row, keyed by column name", async () => {
  const data = volume(mixed)
  const ran = await db(
    data,
    "query",
    "--json",
    "SELECT * FROM mixed ORDER BY rowid",
  )
  expect(ran.stderr).toBe("")
  expect(ran.code).toBe(0)
  expect(ran.stdout.split("\n")).toHaveLength(2)
  expect(JSON.parse(ran.stdout)).toEqual([
    { "na\tme": "one\ttab", number: 1.5, bytes: "x'00ff'" },
    { "na\tme": "two\nlines", number: null, bytes: "x''" },
    { "na\tme": "a\\back\\n", number: "9007199254740993", bytes: null },
    { "na\tme": "", number: 7, bytes: null },
  ])
  expect((await db(data, "query", "SELECT 1 WHERE 0", "--json")).stdout).toBe(
    "[]\n",
  )
})

it("STO-203 chad db query runs the first statement of its argument and ignores what follows it", async () => {
  const data = volume(numbered(2))
  expect(
    await db(data, "query", "SELECT 1 AS first; DELETE FROM numbers; SELECT 2"),
  ).toEqual({ stdout: "first\n1\n", stderr: "", code: 0 })
  expect(query(data, "SELECT count(*) AS n FROM numbers")).toEqual([{ n: 2n }])
})
