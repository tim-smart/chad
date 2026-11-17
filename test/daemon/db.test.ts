import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { version } from "../../dist/Version.js"
import { execute, query } from "../support/database.ts"
import { git } from "../support/applied.ts"
import { fresh, scenario } from "../support/driver.ts"
import { json } from "../support/repo.ts"

test("nothing checks integrity at boot: the daemon boots on a database whose index has lost a row, and chad db check then prints SQLite's own lines and exits 1", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(join(data, "db"), { recursive: true })
  execute(
    data,
    `
      CREATE TABLE notes (text TEXT);
      CREATE INDEX notes_text ON notes (text);
      INSERT INTO notes VALUES ('a note that is whole')
    `,
  )
  expect(query(data, "PRAGMA integrity_check")).toEqual([
    { integrity_check: "ok" },
  ])
  // The text is in the file twice, in the table and in the index. Changing one of the two breaks the index.
  const file = join(data, "db/chad.db")
  const bytes = readFileSync(file)
  bytes.write("a note that is holed", bytes.indexOf("a note that is whole"))
  writeFileSync(file, bytes)

  const running = await scenario({ directory })
  await running.logged("boot.ready")
  expect(await running.chad(["health"])).toMatchObject({ code: 0 })

  const lines = query(data, "PRAGMA integrity_check").map(
    (row) => row["integrity_check"],
  )
  expect(lines).toEqual(["row 1 missing from index notes_text"])
  expect(await running.chad(["db", "check"])).toEqual({
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
    code: 1,
  })
})

test("chad status --json prints the facts as one JSON object on one line, with the daemon up and with none, and exits as chad status does", async () => {
  const running = await scenario()
  const { data } = running
  await running.logged("boot.ready")

  const up = await running.chad(["status", "--json"])
  expect(up.stderr).toBe("")
  expect(up.code).toBe(0)
  expect(up.stdout.split("\n")).toHaveLength(2)
  const answered = JSON.parse(up.stdout)
  const repository = {
    safe: "off",
    applied: {
      commit: git(join(data, "repo/work"), ["rev-parse", "HEAD"]).slice(0, 7),
      message: "First commit",
    },
    draft: false,
  }
  expect(answered).toEqual({
    daemon: "up",
    version,
    effect: json("node_modules/effect/package.json").version,
    phase: "ready",
    filesystem: answered.filesystem,
    connections: [{ name: "local", kind: "local" }],
    started: answered.started,
    problems: [],
    recent: { failed: [], last: [], today: 0, week: 0 },
    model: { spec: "openai-compat/fake", login: "not-needed" },
    plugins: [],
    skipped: [],
    off: [],
    hiding: [],
    repository,
  })
  expect(Array.isArray(answered.filesystem)).toBe(true)

  await running.stop()
  const none = await running.chad(["status", "--json"])
  expect(none.stderr).toBe("")
  expect(none.code).toBe(4)
  expect(none.stdout.split("\n")).toHaveLength(2)
  expect(JSON.parse(none.stdout)).toEqual({
    daemon: "none",
    lock: join(data, "state/daemon.lock"),
    version,
    volume: version,
    connections: [{ name: "local", kind: "local" }],
    model: { spec: "openai/gpt-6-astra/medium", login: "logged-out" },
    repository,
  })
})
