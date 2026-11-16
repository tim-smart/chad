// `chad plugin purge` as the owner and the agent reach it: it drops the key-value table of a plugin that is gone, and
// only that table, and it refuses a plugin that is still in the applied repo and a bundled plugin that is on
// (docs/spec/10-cli.md, 11-settings.md, "Turning a plugin off").
import { rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import { write } from "../support/applied.ts"
import { scenario, type Scenario } from "../support/driver.ts"
import { eventually, posted, rows, says, sessions } from "../support/owner.ts"

/** A repo plugin that stores one key while it loads. */
const storing = (name: string) => `import { Effect, Layer } from "effect"
import { Plugin } from "chad"

export default Plugin.make(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { store } = yield* Plugin.PluginContext
      yield* Effect.orDie(store.set("k", "${name}"))
    }),
  ),
)
`

/** Every table of the database, by name. */
const tables = (running: Pick<Scenario, "data">) =>
  rows(
    running,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).map((row) => String(row["name"]))

test("CLI-90 SET-40 SET-95 API-23 CLI-158 CLI-32 CLI-150 FAIL-176 SELF-126 CLI-247 CLI-248 FAIL-347 chad plugin purge drops only the named plugin's table, never one whose name it prefixes, refuses a repo plugin still in the applied repo whether it is on or off and a bundled plugin that is on, takes a bundled plugin that is off, posts its line in the session that ran it, and exits 4 with no daemon", async () => {
  const notes = Plugin.make(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const { store } = yield* Plugin.PluginContext
        yield* Effect.orDie(store.set("k", "notes"))
      }),
    ),
  )
  const running = await scenario({
    plugins: [{ name: "notes", plugin: notes }],
  })
  const work = join(running.data, "repo/work")
  const purge = (name: string, env?: Record<string, string>) =>
    running.chad(["plugin", "purge", name], env)
  const apply = async (message: string) =>
    expect((await running.chad(["apply", "-m", message])).code).toBe(0)

  write(work, {
    "plugins/memo.ts": storing("memo"),
    "plugins/memos.ts": storing("memos"),
  })
  await apply("Add memo and memos")
  const before = await eventually(
    () => tables(running),
    (names) =>
      ["plugin_kv_memo", "plugin_kv_memos", "plugin_kv_notes"].every((name) =>
        names.includes(name),
      ),
  )

  // A repo plugin in the applied repo and a bundled plugin that is on keep their data.
  const inRepo = await purge("memo")
  expect(inRepo.code).toBe(1)
  expect(inRepo.stderr).toContain(Messages.purgeInRepo("memo"))
  const on = await purge("notes")
  expect(on.code).toBe(1)
  expect(on.stderr).toContain(Messages.purgeBundledOn("notes"))

  // Turned off, the repo plugin is still in the applied repo, and the bundled one can be purged.
  write(work, {
    "chad.json": JSON.stringify({
      plugins: { memo: { enabled: false }, notes: { enabled: false } },
    }),
  })
  await apply("Turn memo and notes off")
  expect((await purge("memo")).code).toBe(1)
  expect(await purge("notes")).toMatchObject({
    code: 0,
    stdout: Messages.purged("notes", 1) + "\n",
  })
  expect(tables(running)).toEqual(
    before.filter((name) => name !== "plugin_kv_notes"),
  )

  // Deleted from the repo and applied, its data goes, and a purge from a session posts its line there.
  rmSync(join(work, "plugins/memo.ts"))
  write(work, {
    "chad.json": JSON.stringify({ plugins: { notes: { enabled: false } } }),
  })
  await apply("Delete memo")
  const thread = await running.fakes.chat.makeThread("direct")
  await running.fakes.model.script([{ text: "ok" }])
  await says(running, thread, "hello")
  await running.fakes.chat.answers(thread, 1)
  const session = String(sessions(running)[0]?.["id"])
  expect(await purge("memo", { CHAD_SESSION: session })).toMatchObject({
    code: 0,
    stdout: Messages.purged("memo", 1) + "\n",
  })
  await eventually(
    () => posted(running, thread),
    (texts) => texts.includes(`-# ${Messages.purgedLine("memo")}`),
  )
  // Every other table and its rows are as they were.
  expect(tables(running)).toEqual(
    before.filter(
      (name) => name !== "plugin_kv_notes" && name !== "plugin_kv_memo",
    ),
  )
  expect(rows(running, "SELECT id FROM plugin_kv_memos")).toEqual([{ id: "k" }])

  // Nothing is left to purge, which changes nothing and posts nothing.
  expect(await purge("memo", { CHAD_SESSION: session })).toMatchObject({
    code: 0,
    stdout: Messages.purgeNothing("memo") + "\n",
  })

  // With no daemon the purge exits 4 and the table stays.
  expect(await running.stop()).toBe(0)
  expect((await purge("memos")).code).toBe(4)
  expect(tables(running)).toContain("plugin_kv_memos")
  expect(
    (await posted(running, thread)).filter((text) => text.startsWith("-# ")),
  ).toEqual([`-# ${Messages.purgedLine("memo")}`])
})
