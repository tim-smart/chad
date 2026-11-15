// The resumed turn and the give-up in layer 4: the daemon as a child process that a scenario kills and starts again
// on the same volume (docs/spec/17-testing.md, TST-27). A kill point is a model response the fake holds (TST-45).
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import {
  eventually,
  found,
  lines,
  posted,
  prompted,
  rows,
  says,
} from "../support/owner.ts"
import { daemon } from "../support/process.ts"

test("SES-99 SES-101 SES-102 SES-103 SES-98 STO-71 STO-72 FAIL-253 FAIL-104 FAIL-103b TST-45 TST-27 TST-28 a turn that a kill cut is delivered again at the next start with no word from the owner, counts a second start before the model runs, resumes with the restart note over the restored history and the first attempt's turn id, and adds its usage to what the killed attempt used", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    {
      tool: { name: "execute", arguments: { script: 'console.log("one")' } },
      usage: { input: 100, output: 10 },
    },
    { text: "never sent", hold: true },
    { text: "finished", usage: { input: 7, output: 3 } },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "count the files")
  await fakes.model.received(2)
  await found(running, "SELECT 1 FROM turns WHERE input_tokens = 100")
  expect((await first.kill()).signal).toBe("SIGKILL")

  await running.start()
  const calls = await fakes.model.received(3)
  expect(prompted(calls[2])).toBe(Messages.restartNote())
  // The restored history goes with it: the owner's message and the script the killed attempt finished.
  expect(JSON.stringify(calls[2]!.body)).toContain("count the files")
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["finished"])

  const [started] = await lines(running, "turn.started", 1)
  const [resumed] = await lines(running, "turn.resumed", 1)
  expect(resumed!.annotations["turn"]).toBe(started!.annotations["turn"])
  expect(resumed!.annotations["starts"]).toBe(2)
  expect(
    rows(
      running,
      "SELECT turn_id, origin, starts, graceful_cuts, outcome, input_tokens, output_tokens FROM turns",
    ),
  ).toEqual([
    {
      turn_id: started!.annotations["turn"],
      origin: "message",
      starts: 2,
      graceful_cuts: 0,
      outcome: "answered",
      input_tokens: 107,
      output_tokens: 13,
    },
  ])
}, 15_000)

test("SES-106 SES-99 SES-202 FAIL-326 after two starts that a kill ended, a SIGTERM followed by a kill before the cut counting as one, the next delivery counts a third start, runs no model, posts the give-up message and records the turn as failed with GaveUp, with only turn.failed for that delivery", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    { text: "never sent", hold: true },
    { text: "never sent", hold: true },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "do the thing")
  await fakes.model.received(1)
  await first.kill()
  const second = await running.start()
  await fakes.model.received(2)
  // Docker's default 10 seconds: SIGTERM, and a kill before the 15 second cut.
  second.signal("SIGTERM")
  await running.logged("stop.started")
  await second.kill()
  await running.start()
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual([Messages.gaveUp()])
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("GaveUp")
  const events = running.log().map((line) => line.annotations["event"])
  expect(events.filter((event) => event === "turn.started")).toHaveLength(1)
  expect(events.filter((event) => event === "turn.resumed")).toHaveLength(1)
  expect(await fakes.model.calls()).toHaveLength(2)
  expect(
    rows(running, "SELECT starts, graceful_cuts, outcome, failure FROM turns"),
  ).toEqual([
    { starts: 3, graceful_cuts: 0, outcome: "failed", failure: "GaveUp" },
  ])
}, 20_000)

test("SES-161 SES-101 a kill after the start is counted and before the prompt is stored resumes with the owner's message and its files, and the restart note after them in the same send", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([{ text: "finished" }])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  const held = running.holdDownloads()
  await says(running, thread, "read my notes", {
    files: [
      {
        name: "notes.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("the notes"),
      },
    ],
  })
  await held.reached
  await found(running, "SELECT 1 FROM turns WHERE starts = 1")
  expect(rows(running, "SELECT seq FROM session_messages")).toEqual([])
  await first.kill()
  held.release()

  await running.start()
  const [call] = await fakes.model.received(1)
  const users = (
    call!.body as {
      messages: ReadonlyArray<{ role: string; content: unknown }>
    }
  ).messages
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content))
  expect(users).toHaveLength(2)
  expect(users[0]).toContain("read my notes")
  expect(users[0]).toContain("notes.txt")
  expect(prompted(call)).toBe(Messages.restartNote())
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["finished"])
  const [resumed] = await lines(running, "turn.resumed", 1)
  expect(resumed!.annotations["starts"]).toBe(2)
}, 15_000)

test("SES-161 SES-101 STO-207 a kill after a compaction took the turn's prompt out of the stored history resumes with the restart note alone, because the record that the prompt was stored outlives the compaction", async () => {
  const running = await daemon()
  const { fakes } = running
  const summary = { text: "the summary" }
  await fakes.model.script([
    // The call says the context is over clanka's threshold, which starts a compaction beside the turn.
    {
      tool: { name: "execute", arguments: { script: 'console.log("one")' } },
      usage: { input: 250_000, output: 10 },
    },
    // The turn's next call and the summarizer's, in either order. The turn's is held.
    {
      tool: { name: "execute", arguments: { script: 'console.log("two")' } },
      hold: true,
      summary,
    },
    {
      tool: { name: "execute", arguments: { script: 'console.log("two")' } },
      hold: true,
      summary,
    },
    // The call that takes the finished compaction, held as the kill point.
    { text: "never sent", hold: true, summary },
    { text: "finished" },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  // Long enough that the compaction does not keep it.
  const long = "a long story. ".repeat(8_000)
  await says(running, thread, long)
  const calls = await fakes.model.received(3)
  const own = [1, 2].find((index) =>
    JSON.stringify(calls[index]!.body).includes('"role":"tool"'),
  )!
  fakes.model.release(own)
  await fakes.model.received(4)
  await eventually(
    () => rows(running, "SELECT message FROM session_messages"),
    (stored) =>
      stored.length > 0 &&
      !stored.some((row) => String(row["message"]).includes("a long story.")),
  )
  expect(rows(running, "SELECT request_key FROM prompts")).toHaveLength(1)
  await first.kill()

  await running.start()
  const all = await fakes.model.received(5)
  const resumed = JSON.stringify(all[4]!.body)
  expect(resumed).not.toContain("a long story.")
  expect(resumed).toContain("the summary")
  expect(prompted(all[4])).toBe(Messages.restartNote())
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["finished"])
}, 20_000)

test.each([
  ["whose prompts carry their request key", false],
  ["written before prompts carried a key", true],
])(
  "SES-161 SES-101 STO-210 a turn that a kill cut on a volume %s, after its prompt was stored, resumes after the upgrade with the restart note alone",
  async (_, untagged) => {
    const running = await daemon()
    const { fakes } = running
    await fakes.model.script([
      {
        tool: { name: "execute", arguments: { script: 'console.log("one")' } },
      },
      { text: "never sent", hold: true },
      { text: "finished" },
    ])
    const first = await running.start()
    const thread = await fakes.chat.makeThread("direct")
    await says(running, thread, "do the thing once")
    await fakes.model.received(2)
    await found(running, "SELECT 1 FROM prompts")
    await first.kill()

    // The volume as a build before the prompts table left it: schema 2, with or without the key on the prompt.
    const db = new DatabaseSync(join(running.data, "db/chad.db"))
    db.exec(`
      DROP TABLE prompts;
      DROP TABLE commands;
      DELETE FROM effect_sql_migrations WHERE migration_id > 2;
    `)
    if (untagged) {
      db.exec(
        "UPDATE session_messages SET message = json_remove(message, '$.options.chad')",
      )
    }
    db.close()

    await running.start()
    const calls = await fakes.model.received(3)
    const sent = JSON.stringify(calls[2]!.body)
    expect(sent.split("do the thing once")).toHaveLength(2)
    expect(prompted(calls[2])).toBe(Messages.restartNote())
    await fakes.chat.answers(thread, 1)
    expect(await posted(running, thread)).toEqual(["finished"])
  },
  20_000,
)

test.each([
  ["that had not run the migration that filled prompts", false],
  ["that had run it already", true],
])(
  "SES-161 SES-101 STO-210 a turn that a kill cut before its prompt was stored, on a volume %s, with an earlier history that carries no key, resumes after the upgrade with the owner's message and its files",
  async (_, ran) => {
    const running = await daemon()
    const { fakes } = running
    await fakes.model.script([{ text: "first answer" }, { text: "finished" }])
    const first = await running.start()
    const thread = await fakes.chat.makeThread("direct")
    await says(running, thread, "hello")
    await fakes.chat.answers(thread, 1)
    await found(running, "SELECT 1 FROM turns WHERE outcome = 'answered'")
    const held = running.holdDownloads()
    await says(running, thread, "read my notes", {
      files: [
        {
          name: "notes.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("the notes"),
        },
      ],
    })
    await held.reached
    await found(
      running,
      "SELECT 1 FROM turns WHERE ended_at IS NULL AND starts = 1",
    )
    await first.kill()
    held.release()

    // The earlier turn's history carries no key, as after a compaction or from a build before keys. The volume is at
    // schema 3, or at schema 4 with the row that migration 4 inferred for the cut turn.
    const db = new DatabaseSync(join(running.data, "db/chad.db"))
    db.exec(`
      UPDATE session_messages SET message = json_remove(message, '$.options.chad');
      DELETE FROM effect_sql_migrations WHERE migration_id > ${ran ? 4 : 3};
    `)
    if (ran) {
      db.exec(`
        UPDATE effect_sql_migrations SET created_at = current_timestamp WHERE migration_id = 4;
        INSERT INTO prompts (request_key, session_id)
          SELECT request_key, session_id FROM turns WHERE ended_at IS NULL;
      `)
    }
    db.close()

    await running.start()
    const calls = await fakes.model.received(2)
    const users = (
      calls[1]!.body as {
        messages: ReadonlyArray<{ role: string; content: unknown }>
      }
    ).messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content))
    expect(users.at(-2)).toContain("read my notes")
    expect(users.at(-2)).toContain("notes.txt")
    expect(prompted(calls[1])).toBe(Messages.restartNote())
    await fakes.chat.answers(thread, 2)
    expect(await posted(running, thread)).toEqual(["first answer", "finished"])
  },
  20_000,
)
