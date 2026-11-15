import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { version } from "../../dist/Version.js"
import { execute, query } from "../support/database.ts"
import { fresh, owner, scenario } from "../support/driver.ts"
import { printed, runs } from "../support/model.ts"
import { json, path } from "../support/repo.ts"

test("STO-80 STO-83a CLI-130 with a daemon running, the agent runs chad db query and chad db check in its turn and reads what the owner's shell reads", async () => {
  const running = await scenario()
  const { fakes, data } = running
  const chad = `CHAD_DATA=${data} ${process.execPath} ${path("bin/chad.js")}`
  const sessions = "SELECT id, thread FROM sessions"
  await fakes.model.script([
    runs(`
      console.log(await run(${JSON.stringify(`${chad} db query --json "${sessions}"`)}))
      console.log(await run(${JSON.stringify(`${chad} db check`)}))
    `),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  const event = await fakes.chat.userPosts(thread, {
    text: "hello",
    authorId: owner,
  })
  expect(await fakes.chat.deliver(event)).toBe(true)
  await fakes.chat.answers(thread, 1)

  const read = await running.chad(["db", "query", "--json", sessions])
  expect(read.stderr).toBe("")
  expect(read.code).toBe(0)
  const rows: ReadonlyArray<{ id: string; thread: string }> = JSON.parse(
    read.stdout,
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(await running.chad(["db", "check"])).toEqual({
    stdout: "ok\n",
    stderr: "",
    code: 0,
  })

  // What the agent's two commands printed is what the model's next call carries as the tool's result.
  const [, next] = await fakes.model.calls()
  expect(printed(next)).toEqual([`${read.stdout}\nok\n\n`])
})

test("STO-82 STO-174 STO-175 CLI-131 nothing checks integrity at boot: the daemon boots on a database whose index has lost a row, and chad db check then prints SQLite's own lines and exits 1", async () => {
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

test("CLI-46a CLI-237 chad status --json prints the facts as one JSON object on one line, with the daemon up and with none, and exits as chad status does", async () => {
  const running = await scenario()
  const { data } = running
  await running.logged("boot.ready")

  const up = await running.chad(["status", "--json"])
  expect(up.stderr).toBe("")
  expect(up.code).toBe(0)
  expect(up.stdout.split("\n")).toHaveLength(2)
  const answered = JSON.parse(up.stdout)
  expect(answered).toEqual({
    daemon: "up",
    version,
    effect: json("node_modules/effect/package.json").version,
    phase: "ready",
    filesystem: answered.filesystem,
    connections: [{ name: "local", kind: "local" }],
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
  })
})
