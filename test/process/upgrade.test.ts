// A turn that a kill cut on a volume an earlier build left, resumed or held after the upgrade, in layer 4: the daemon as
// a child process that a scenario kills, the volume set back to an earlier schema, and the daemon started again on it
// (docs/spec/17-testing.md, TST-27).
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import {
  eventually,
  found,
  posted,
  prompted,
  rows,
  says,
} from "../support/owner.ts"
import { daemon } from "../support/process.ts"

test.each([
  ["whose prompts carry their request key", false],
  ["written before prompts carried a key", true],
])(
  "SES-161 SES-101 STO-211 a turn that a kill cut on a volume %s, after its prompt was stored, resumes after the upgrade with the restart note alone",
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
      DROP TABLE unproven;
      DROP TABLE session_updates;
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

/** Waits for the next message in the thread to be answered, stops the daemon and gives every call the model received. */
const answersNext = async (
  running: Awaited<ReturnType<typeof daemon>>,
  thread: Parameters<typeof says>[1],
  next: { readonly answered: number },
) => {
  await says(running, thread, "and now this")
  await running.fakes.chat.answers(thread, next.answered)
  return running.fakes.model.received(0)
}

test.each([
  ["that had not run the migration that filled prompts", false],
  ["that had run it already", true],
])(
  "STO-211 STO-210 SES-200 a turn that a kill cut before its prompt was stored, on a volume %s, with an earlier history that carries no key, is held after the upgrade: it starts nothing and the thread's next message is answered",
  async (_, ran) => {
    const running = await daemon()
    const { fakes } = running
    await fakes.model.script([
      { text: "first answer" },
      { text: "the next answer" },
    ])
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
      DROP TABLE unproven;
      DROP TABLE session_updates;
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

    const second = await running.start()
    const calls = await answersNext(running, thread, { answered: 2 })
    await second.stop()
    expect(await posted(running, thread)).toEqual([
      "first answer",
      "the next answer",
    ])
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls[1]!.body)).not.toContain("notes.txt")
    expect(
      rows(
        running,
        "SELECT t.starts, t.outcome FROM turns t JOIN unproven u USING (request_key)",
      ),
    ).toEqual([{ starts: 1, outcome: null }])
  },
  20_000,
)

test.each([
  ["at schema 3", 3, 0, true],
  [
    "at schema 4, whose migration 4 ran in the second the turn started",
    4,
    0,
    true,
  ],
  [
    "at schema 4, whose migration 4 ran a second before the turn started",
    4,
    1,
    false,
  ],
])(
  "STO-211 STO-210 STO-207 SES-161 SES-101 a turn whose prompt was stored and then compacted out of the history, on a model that reports no usage, cut by a kill on a volume %s, never has its prompt sent again after the upgrade",
  async (_, schema, earlier, unproven) => {
    const running = await daemon()
    const { fakes } = running
    const summary = { text: "the summary", unmetered: true }
    await fakes.model.script([
      // No usage comes back, so clanka estimates the context from the prompt, which is over its threshold.
      {
        tool: { name: "execute", arguments: { script: 'console.log("one")' } },
        unmetered: true,
      },
      {
        tool: { name: "execute", arguments: { script: 'console.log("two")' } },
        hold: true,
        unmetered: true,
        summary,
      },
      {
        tool: { name: "execute", arguments: { script: 'console.log("two")' } },
        hold: true,
        unmetered: true,
        summary,
      },
      { text: "never sent", hold: true, unmetered: true, summary },
      { text: unproven ? "the next answer" : "finished", unmetered: true },
    ])
    const first = await running.start()
    const thread = await fakes.chat.makeThread("direct")
    const long = "a long story. ".repeat(60_000)
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
    expect(
      rows(running, "SELECT input_tokens, output_tokens FROM turns"),
    ).toEqual([{ input_tokens: 0, output_tokens: 0 }])
    expect(rows(running, "SELECT request_key FROM prompts")).toHaveLength(1)
    await first.kill()

    // The volume as the build at that schema left it. The history and the prompts row are as the kill left them.
    const db = new DatabaseSync(join(running.data, "db/chad.db"))
    db.exec(`
      DROP TABLE unproven;
      DROP TABLE session_updates;
      DELETE FROM effect_sql_migrations WHERE migration_id > ${schema};
      UPDATE effect_sql_migrations
        SET created_at = datetime((SELECT started_at FROM turns) / 1000 - ${earlier}, 'unixepoch')
        WHERE migration_id = 4;
    `)
    db.close()

    const second = await running.start()
    if (unproven) {
      const all = await answersNext(running, thread, { answered: 1 })
      await second.stop()
      expect(all).toHaveLength(5)
      expect(JSON.stringify(all[4]!.body).split("a long story.")).toHaveLength(
        1,
      )
      expect(prompted(all[4])).toBe("and now this")
      expect(await posted(running, thread)).toEqual(["the next answer"])
    } else {
      const all = await fakes.model.received(5)
      expect(JSON.stringify(all[4]!.body)).not.toContain("a long story.")
      expect(prompted(all[4])).toBe(Messages.restartNote())
      await fakes.chat.answers(thread, 1)
      expect(await posted(running, thread)).toEqual(["finished"])
    }
  },
  30_000,
)
