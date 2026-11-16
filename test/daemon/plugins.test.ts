// Plugins handed to `runDaemon` (TST-202): what a plugin reaches, the turns it starts, and its hooks' budgets.
import { Deferred, Effect, Layer, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { ChatThread } from "effect/chat"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Plugin from "../../dist/Plugin.js"
import * as Session from "../../dist/Session.js"
import { Turns } from "../../dist/Turns.js"
import sendFile from "../../dist/plugins/send-file.js"
import { scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { posted, prompted, rows, says } from "../support/owner.ts"

const tool = <const Name extends string>(name: Name) =>
  Toolkit.make(
    Tool.make(name, {
      description: `The test's ${name}.`,
      parameters: Schema.Struct({}),
      success: Schema.String,
      dependencies: [Session.CurrentSession],
    }),
  )

test("STO-56 STO-57 STO-58 API-30 API-31 API-32 API-49 SES-60 SWAP-36 a plugin has its own store and no SqlClient, its tool sees the session and the turn, and its chunk and context reach the model", async () => {
  let sql: boolean | undefined
  const recall = tool("recall")
  const alpha = Plugin.make(
    Plugin.toolkit(recall).pipe(
      Layer.provide(
        recall.toLayer(
          Effect.gen(function* () {
            const { store } = yield* Plugin.PluginContext
            sql = Option.isSome(
              yield* Effect.serviceOption(SqlClient.SqlClient),
            )
            yield* Effect.orDie(store.set("k", "alpha"))
            return recall.of({
              recall: () =>
                Effect.gen(function* () {
                  const current = yield* Session.CurrentSession
                  const turn = yield* current.turn
                  const value = yield* Effect.orDie(store.get("k"))
                  return `${value ?? "none"} ${current.session.kind} ${Option.isSome(turn)}`
                }),
            })
          }),
        ),
      ),
    ),
    Plugin.prompt(() => Effect.succeed("alpha chunk text")),
    Plugin.beforeTurn(() => Effect.succeed("alpha context text")),
  )
  const beta = Plugin.make(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const { store } = yield* Plugin.PluginContext
        yield* Effect.orDie(store.set("k", "beta"))
      }),
    ),
  )
  const running = await scenario({
    plugins: [
      { name: "alpha", plugin: alpha },
      { name: "beta", plugin: beta },
    ],
  })
  const { fakes } = running
  await fakes.model.script([
    runs("console.log(await recall({}))"),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)

  expect(sql).toBe(false)
  const [first, second] = await fakes.model.calls()
  const sent = JSON.stringify(first?.body)
  expect(sent).toContain("alpha chunk text")
  expect(sent).toContain("alpha context text")
  expect(results(second).join("\n")).toContain("alpha direct true")
  // Each plugin's keys are in its own table, so the same key holds two values.
  const tables = rows(
    running,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plugin_kv_%' ORDER BY name",
  ).map((row) => row["name"])
  expect(tables).toEqual(["plugin_kv_alpha", "plugin_kv_beta"])
  expect(
    JSON.stringify(rows(running, "SELECT * FROM plugin_kv_beta")),
  ).not.toContain("alpha")
})

test("API-72 API-73 API-77 API-79 CRON-99 a plugin's turn runs in another thread with the plugin as its origin, a [SILENT] answer is not posted, and a start in the tool's own thread fails at once", async () => {
  let other: ChatThread.ChatThread | undefined
  const kick = tool("kick")
  const kicker = Plugin.make(
    Plugin.toolkit(kick).pipe(
      Layer.provide(
        kick.toLayer(
          Effect.gen(function* () {
            const turns = yield* Turns
            return kick.of({
              kick: () =>
                Effect.gen(function* () {
                  const { session } = yield* Session.CurrentSession
                  const own = yield* Effect.exit(
                    turns.start({
                      thread: session.thread,
                      prompt: "never",
                      label: "own",
                    }),
                  )
                  const first = yield* turns.start({
                    thread: other!,
                    prompt: "ping one",
                    label: "kick",
                  })
                  const second = yield* turns.start({
                    thread: other!,
                    prompt: "ping two",
                    label: "kick",
                  })
                  return [own._tag, first._tag, second._tag].join(" ")
                }),
            })
          }),
        ),
      ),
    ),
  )
  const running = await scenario({
    plugins: [{ name: "kicker", plugin: kicker }],
  })
  const { fakes } = running
  // The tool's turn waits for each turn it starts, so the calls come in this order.
  await fakes.model.script([
    runs("console.log(await kick({}))"),
    { text: "from the plugin" },
    { text: "[SILENT]" },
    { text: "kicked" },
  ])
  other = await fakes.chat.makeThread("direct")
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)

  const calls = await fakes.model.calls()
  expect(prompted(calls[1])).toContain("ping one")
  expect(results(calls[3]).join("\n")).toContain("Failure Answered Answered")
  expect(await posted(running, other)).toEqual(["from the plugin"])
  const turns = rows(
    running,
    "SELECT request_key, origin, origin_plugin, origin_label, outcome FROM turns WHERE origin = 'plugin' ORDER BY started_at",
  )
  expect(turns).toHaveLength(2)
  for (const turn of turns) {
    expect(turn).toMatchObject({
      origin: "plugin",
      origin_plugin: "kicker",
      origin_label: "kick",
      outcome: "answered",
    })
    expect(String(turn["request_key"])).toMatch(/^start\/[0-9a-f-]{36}$/)
  }
})

test("API-38 API-40 API-54 SES-69b a beforeTurn hook past its budget is dropped and logged and the turn runs, and afterTurn runs for a turn the owner stopped", async () => {
  const ended = Deferred.makeUnsafe<string>()
  const slow = Plugin.make(
    Plugin.beforeTurn(() => Effect.as(Effect.never, "never"), {
      timeout: "50 millis",
    }),
    Plugin.afterTurn((turn) =>
      Deferred.succeed(ended, turn.outcome._tag).pipe(Effect.asVoid),
    ),
  )
  const running = await scenario({ plugins: [{ name: "slow", plugin: slow }] })
  const { fakes } = running
  await fakes.model.script([{ ...runs('console.log("ran")'), hold: true }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  const failed = await running.logged("hook.failed")
  expect(failed.annotations).toMatchObject({ plugin: "slow" })
  await fakes.model.received(1)
  await says(running, thread, "/stop")
  expect(await Effect.runPromise(Deferred.await(ended))).toBe("Stopped")
})

test("API-33 a plugin whose tool name another plugin holds is skipped with the holder's name, and the rest load", async () => {
  const same = tool("same")
  const make = () =>
    Plugin.make(
      Plugin.toolkit(same).pipe(
        Layer.provide(
          same.toLayer(
            Effect.succeed(same.of({ same: () => Effect.succeed("ok") })),
          ),
        ),
      ),
    )
  const running = await scenario({
    plugins: [
      { name: "first", plugin: make() },
      { name: "second", plugin: make() },
    ],
  })
  const { fakes } = running
  const skipped = await running.logged("plugin.skipped")
  expect(skipped.annotations["plugin"]).toBe("second")
  expect(String(skipped.annotations["reason"])).toContain("first")
  await fakes.model.script([
    runs("console.log(await same({}))"),
    { text: "ok" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  expect(results((await fakes.model.calls())[1]).join("\n")).toContain("ok")
})

test("DIS-65 DIS-66 DIS-68 DIS-69 DIS-105 the bundled sendFile posts a file the agent wrote, named by a relative path, with its caption in the session's thread before the answer", async () => {
  const running = await scenario({
    plugins: [{ name: "send-file", plugin: sendFile }],
  })
  const { fakes } = running
  // The script writes the file in its working directory and names it as the agent would, relative to it.
  await fakes.model.script([
    runs(
      `await writeFile({ path: "report.txt", content: "the report" }); console.log(await sendFile({ path: "report.txt", caption: "here it is" }))`,
    ),
    { text: "sent" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "send it")
  await fakes.chat.answers(thread, 2)

  expect(await posted(running, thread)).toEqual(["here it is", "sent"])
  const post = (await Effect.runPromise(running.chat.calls)).find(
    (call) =>
      call.op === "post" && call.files !== undefined && call.files.length > 0,
  )
  expect(
    post?.files?.map((sent) => [
      sent.name,
      new TextDecoder().decode(sent.content),
    ]),
  ).toEqual([["report.txt", "the report"]])
  expect(results((await fakes.model.calls())[1]).join("\n")).toContain(
    "sent report.txt",
  )
})
