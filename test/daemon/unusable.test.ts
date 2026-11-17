import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { execute, query } from "../support/database.ts"
import { fresh, scenario, type Scenario } from "../support/driver.ts"
import { eventually, lines, posted, says } from "../support/owner.ts"

/** The answer an unusable database gives, from the error the boot logged. */
const answer = async (chad: Scenario) => {
  const line = await chad.logged("database.unusable")
  return Messages.databaseUnusable(String(line.annotations["error"]))
}

/** Every try to send the notice of an unusable database, delivered or not. */
const tries = (chad: Scenario) =>
  chad
    .log()
    .filter(
      (line) =>
        ["notice.sent", "notice.undelivered"].includes(
          String(line.annotations["event"]),
        ) && line.annotations["key"] === "database-unusable",
    )

test("a corrupt database keeps chad up without sessions, answers the owner with the error, and sends its notice once across restarts", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(join(data, "db"), { recursive: true })
  writeFileSync(
    join(data, "db/chad.db"),
    "this is not a database, ".repeat(400),
  )
  // The boot posts its notice once the connection is up, by which time the thread is recorded.
  let up = () => {}
  const loading = new Promise<void>((resolve) => (up = resolve))
  const first = await scenario({ directory, loading })
  const recorded = await first.fakes.chat.makeThread("direct")
  mkdirSync(join(data, "state"), { recursive: true })
  writeFileSync(
    join(data, "state/notice-thread"),
    JSON.stringify({
      connection: "local",
      thread: ChatThread.toString(recorded),
    }) + "\n",
  )
  up()
  const text = await answer(first)
  expect(
    await eventually(
      () => posted(first, recorded),
      (all) => all.length > 0,
    ),
  ).toEqual([text])
  await eventually(() => existsSync(join(data, "state/db-unusable")), Boolean)

  const thread = await first.fakes.chat.makeThread("direct")
  const stranger = await first.fakes.chat.userPosts(thread, {
    text: "hello",
    authorId: "stranger",
  })
  expect(await first.fakes.chat.deliver(stranger)).toBe(true)
  await says(first, thread, "hello")
  await says(first, thread, "/status")
  const [error, status] = await first.fakes.chat.answers(thread, 2)
  expect(error?.text).toBe(text)
  expect(status?.text).toContain(text)
  // The stranger's message got nothing, so the error went to the owner alone.
  expect(await posted(first, thread)).toEqual([text, status?.text])
  expect(await first.fakes.model.calls()).toEqual([])
  expect((await first.chad(["status"])).stdout).toContain(text)
  expect(await first.stop()).toBe(0)

  // A restart on the same database sends nothing, because the mark says the notice went out.
  const second = await scenario({ directory })
  await lines(second, "boot.ready", 2)
  expect(await second.stop()).toBe(0)
  expect(tries(second)).toHaveLength(1)

  // A boot that opens and migrates the database removes the mark.
  rmSync(join(data, "db"), { recursive: true })
  const third = await scenario({ directory })
  await lines(third, "boot.ready", 3)
  expect(existsSync(join(data, "state/db-unusable"))).toBe(false)
})

test("a database that holds a migration this chad does not know starts no session and is left as it is", async () => {
  const first = await scenario()
  await first.logged("boot.ready")
  expect(await first.stop()).toBe(0)
  execute(
    first.data,
    "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'future')",
  )
  const migrations = query(first.data, "SELECT * FROM effect_sql_migrations")

  const second = await scenario({ directory: first.directory })
  const text = await answer(second)
  const thread = await second.fakes.chat.makeThread("direct")
  await says(second, thread, "hello")
  expect(await second.fakes.chat.answers(thread, 1)).toMatchObject([{ text }])
  expect(await second.fakes.model.calls()).toEqual([])
  expect(await second.stop()).toBe(0)
  expect(query(first.data, "SELECT * FROM effect_sql_migrations")).toEqual(
    migrations,
  )
})
