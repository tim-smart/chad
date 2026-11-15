// The resumed turn and the give-up in layer 4: the daemon as a child process that a scenario kills and starts again
// on the same volume (docs/spec/17-testing.md, TST-27). A kill point is a model response the fake holds (TST-45).
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Failed from "../../dist/daemon/Failed.js"
import { execute } from "../support/database.ts"
import {
  eventually,
  found,
  lines,
  posted,
  prompted,
  rows,
  says,
  statusMessages,
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

test("SES-106 SES-99 SES-202 FAIL-326 FAIL-63a FAIL-63b DIS-62 FAIL-65 after two starts that a kill ended, a SIGTERM followed by a kill before the cut counting as one, the next delivery counts a third start, runs no model, posts the give-up message and records the turn as failed with GaveUp, with only turn.failed for that delivery, and removes the status message the turn left behind", async () => {
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
  await second.signal("SIGTERM")
  await running.logged("stop.started")
  await second.kill()
  await running.start()
  await fakes.chat.answers(thread, 1)
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("GaveUp")
  expect(await posted(running, thread)).toEqual([
    Messages.gaveUp(String(failed!.annotations["turn"])),
  ])
  // The resumed start edited the message of the first, and the give-up removed it.
  expect(await fakes.chat.statuses()).toHaveLength(1)
  expect(await statusMessages(running, thread)).toEqual([])
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

test("SES-104 DIS-32 STO-75 a turn that a kill cut edits the status message its first start posted, adding the restart line, posts no second one, and removes it before the answer", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    { text: "never sent", hold: true },
    { text: "finished", hold: true },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "do the thing")
  await fakes.model.received(1)
  const [row] = await found(
    running,
    "SELECT started_at, status_message_id FROM turns WHERE status_message_id IS NOT NULL",
  )
  await first.kill()

  await running.start()
  await fakes.model.received(2)
  await eventually(
    () => statusMessages(running, thread),
    (texts) =>
      texts.length === 1 &&
      texts[0] ===
        Messages.statusMessage(Number(row!["started_at"]), [
          Messages.statusRestarted(),
        ]),
  )
  expect(await fakes.chat.statuses()).toEqual([row!["status_message_id"]])
  await fakes.model.release(1)
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["finished"])
  expect(await statusMessages(running, thread)).toEqual([])
  expect(await fakes.chat.statuses()).toHaveLength(1)
}, 15_000)

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

test("SES-152 SES-153 SES-205 TST-182 a stored request that the next start cannot decode ends failed with Internal and the failed-turn message at once, counts no start, runs no model and is answered, so it is not tried again", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([{ text: "never sent", hold: true }])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "do the thing")
  await fakes.model.received(1)
  await first.kill()
  // What a deploy that changes effect/chat's encoding leaves on the volume.
  execute(
    running.data,
    "UPDATE cluster_messages SET payload = json_set(payload, '$.message', 'not a message') WHERE tag = 'message'",
  )
  await running.start()
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("Internal")
  const [row] = await found(
    running,
    "SELECT turn_id, starts, outcome, failure, failure_detail FROM turns WHERE outcome IS NOT NULL",
  )
  expect(row).toMatchObject({
    starts: 1,
    outcome: "failed",
    failure: "Internal",
  })
  const reason = Failed.fromRow("Internal", String(row!["failure_detail"]))
  if (reason._tag !== "Internal") throw new Error("not Internal")
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual([
    Messages.failedTurn(0, reason, String(row!["turn_id"])),
  ])
  expect(await fakes.model.calls()).toHaveLength(1)
  await found(
    running,
    "SELECT 1 FROM cluster_replies r JOIN cluster_messages m ON m.id = r.request_id WHERE m.tag = 'message'",
  )
  // The boot went on past the request it could not decode.
  await lines(running, "boot.ready", 2)
}, 20_000)

test("FAIL-135 FAIL-140 SES-99 SES-101 SES-103 SES-200 a turn whose end the full volume cannot write gets the ordinary failed-turn message and no reply, the thread's later messages still answer, and a restart resumes it as a turn a crash cut", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    { text: "never posted", hold: true },
    { text: "second answer" },
    { text: "resumed answer" },
    { text: "later answer" },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "first")
  await fakes.model.received(1)
  // No test can fill the volume, so a trigger fails the turn's end with SQLite's full text.
  execute(
    running.data,
    "CREATE TRIGGER full BEFORE UPDATE OF outcome ON turns WHEN NEW.outcome IS NOT NULL BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
  )
  await fakes.model.release(0)
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("Internal")
  await fakes.chat.answers(thread, 1)
  const turn = String(failed!.annotations["turn"])
  const [told] = await posted(running, thread)
  expect(told).toContain(Messages.turnLine(turn))
  execute(running.data, "DROP TRIGGER full")
  expect(
    rows(running, "SELECT turn_id, starts, outcome, ended_at FROM turns"),
  ).toEqual([{ turn_id: turn, starts: 1, outcome: null, ended_at: null }])

  // The thread's next message does not wait behind the turn that has no end.
  await says(running, thread, "second")
  await fakes.chat.answers(thread, 2)
  await first.kill()

  await running.start()
  const calls = await fakes.model.received(3)
  expect(prompted(calls[2])).toBe(Messages.restartNote())
  await fakes.chat.answers(thread, 3)
  const [resumed] = await lines(running, "turn.resumed", 1)
  expect(resumed!.annotations["turn"]).toBe(turn)
  expect(resumed!.annotations["starts"]).toBe(2)
  await says(running, thread, "later")
  await fakes.chat.answers(thread, 4)
  expect((await posted(running, thread)).slice(1)).toEqual([
    "second answer",
    "resumed answer",
    "later answer",
  ])
  expect(
    rows(running, "SELECT starts, outcome FROM turns ORDER BY started_at"),
  ).toEqual([
    { starts: 2, outcome: "answered" },
    { starts: 1, outcome: "answered" },
    { starts: 1, outcome: "answered" },
  ])
}, 20_000)

test("FAIL-135 FAIL-281 SES-99 a turn whose row the full volume cannot insert gets the ordinary failed-turn message and no reply and leaves no update, the thread's later messages still answer, and a restart delivers it again as a fresh turn", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    { text: "second answer" },
    { text: "first answer" },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  // No test can fill the volume, so a trigger fails the turn's first row with SQLite's full text.
  execute(
    running.data,
    "CREATE TRIGGER full BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
  )
  await says(running, thread, "first")
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("Internal")
  await fakes.chat.answers(thread, 1)
  const [told] = await posted(running, thread)
  expect(told).toContain(Messages.turnLine(String(failed!.annotations["turn"])))
  execute(running.data, "DROP TRIGGER full")
  expect(rows(running, "SELECT request_key FROM turns")).toEqual([])
  expect(rows(running, "SELECT seq FROM session_updates")).toEqual([])

  // The thread's next message does not wait behind the request that has no row.
  await says(running, thread, "second")
  await fakes.chat.answers(thread, 2)
  await first.kill()

  await running.start()
  const calls = await fakes.model.received(2)
  expect(prompted(calls[1])).toBe("first")
  await fakes.chat.answers(thread, 3)
  expect((await posted(running, thread)).slice(1)).toEqual([
    "second answer",
    "first answer",
  ])
  expect(
    rows(running, "SELECT starts, outcome FROM turns ORDER BY started_at"),
  ).toEqual([
    { starts: 1, outcome: "answered" },
    { starts: 1, outcome: "answered" },
  ])
}, 20_000)

test("FAIL-135 SES-99 a turn whose session directory cannot be made has its start counted before anything else, so it ends failed with Internal and the ordinary failed-turn message, its status message is removed, and the thread's later messages still answer", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([{ text: "second answer" }])
  await running.start()
  const thread = await fakes.chat.makeThread("direct")
  // A file where the sessions directory belongs fails the new session's directory.
  const sessions = join(running.data, "sessions")
  rmSync(sessions, { recursive: true })
  writeFileSync(sessions, "")
  await says(running, thread, "first")
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("Internal")
  await fakes.chat.answers(thread, 1)
  rmSync(sessions)
  mkdirSync(sessions)
  expect(rows(running, "SELECT starts, outcome, failure FROM turns")).toEqual([
    { starts: 1, outcome: "failed", failure: "Internal" },
  ])

  await says(running, thread, "second")
  await fakes.chat.answers(thread, 2)
  expect((await posted(running, thread)).slice(1)).toEqual(["second answer"])
  expect(await statusMessages(running, thread)).toEqual([])
}, 20_000)
