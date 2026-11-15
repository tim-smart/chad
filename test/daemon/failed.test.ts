import { Effect } from "effect"
import { ChatError } from "effect/chat"
import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import * as Failed from "../../dist/daemon/Failed.js"
import { scenario } from "../support/driver.ts"
import type { Call } from "../support/model.ts"
import { execute } from "../support/database.ts"
import { found, lines, posted, rows, says } from "../support/owner.ts"

/** The text of each user message a model call sent. */
const userTexts = (call: Call | undefined): ReadonlyArray<string> => {
  const body = call?.body as {
    readonly messages?: ReadonlyArray<{
      readonly role: string
      readonly content: string | ReadonlyArray<{ readonly text?: string }>
    }>
  }
  return (body.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join(""),
    )
}

test("FAIL-43 FAIL-54 FAIL-55 FAIL-65 FAIL-16 STO-76 API-112 FAIL-125 FAIL-127 FAIL-131 FAIL-215 a turn whose model request fails posts the failed-turn message with its turn id, logs turn.failed with ModelError and records the whole reason, and the next turn tells the model in one update message ahead of the owner's, whose line is cleared with the history that holds it", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ status: 400 }, { text: "back" }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)

  const [failed] = await lines(running, "turn.failed", 1)
  const turn = String(failed!.annotations["turn"])
  expect(failed!.annotations["reason"]).toBe("ModelError")
  const [row] = rows(
    running,
    "SELECT turn_id, outcome, failure, failure_detail FROM turns",
  )
  expect(row).toMatchObject({
    turn_id: turn,
    outcome: "failed",
    failure: "ModelError",
  })
  const reason = Failed.fromRow("ModelError", String(row!["failure_detail"]))
  expect(reason).toMatchObject({ _tag: "ModelError", retries: 0 })
  if (reason._tag !== "ModelError") throw new Error("not a ModelError")
  expect(await posted(running, thread)).toEqual([
    Messages.failedTurn(
      Format.local,
      Number(failed!.annotations["duration_ms"]),
      reason,
      turn,
    ),
  ])
  await found(running, "SELECT 1 FROM session_updates")

  await says(running, thread, "again")
  await fakes.chat.answers(thread, 2)
  const update = Messages.update([
    { turn, outcome: "failed", failure: "ModelError" },
  ])
  const sent = userTexts((await fakes.model.calls())[1])
  expect(update).toBeDefined()
  expect(sent.filter((text) => text === update)).toHaveLength(1)
  expect(sent.indexOf(update!)).toBe(sent.length - 2)
  expect(sent.at(-1)).toContain("again")
  // The history that holds the update message was stored, and its line went with it.
  const stored = rows(running, "SELECT message FROM session_messages")
    .map((message) => String(message["message"]))
    .filter((message) => message.includes("environment-update"))
  expect(stored).toHaveLength(1)
  expect(rows(running, "SELECT * FROM session_updates")).toEqual([])
})

test("FAIL-132 FAIL-51 API-99 DIS-54 FAIL-256 a turn that answered adds nothing for the next turn, and an answer whose post failed twice is logged as turn.answer-unposted, stays answered and is told to the model at the next turn", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([
    { text: "one" },
    { text: "two", hold: true },
    { text: "three" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  await lines(running, "turn.ended", 1)
  expect(rows(running, "SELECT * FROM session_updates")).toEqual([])

  // The answer's post fails, and so does its second try. Both come after the status message's post.
  await says(running, thread, "more")
  await fakes.model.received(2)
  await Effect.runPromise(
    chat.failNext(
      "post",
      new ChatError.Forbidden({ detail: "Missing Access" }),
      { times: 2 },
    ),
  )
  await fakes.model.release(1)
  const [, second] = await lines(running, "turn.ended", 2)
  const turn = String(second!.annotations["turn"])
  const [unposted] = await lines(running, "turn.answer-unposted", 1)
  expect(unposted!.annotations["turn"]).toBe(turn)
  expect(second!.annotations["outcome"]).toBe("answered")
  await found(running, "SELECT 1 FROM session_updates")

  await says(running, thread, "and more")
  await fakes.chat.answers(thread, 2)
  const calls = await fakes.model.calls()
  const update = Messages.update([{ turn, outcome: "answered" }])
  expect(
    userTexts(calls[1]).some((text) => text.includes("environment-update")),
  ).toBe(false)
  expect(userTexts(calls[2])).toContain(update)
  expect(
    rows(running, "SELECT outcome FROM turns ORDER BY started_at"),
  ).toEqual([
    { outcome: "answered" },
    { outcome: "answered" },
    { outcome: "answered" },
  ])
})

test("FAIL-44 a turn whose thread is gone when its answer is posted ends failed with ThreadGone, posts nothing, and logs turn.failed in place of turn.ended", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([{ text: "one", hold: true }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(1)
  await Effect.runPromise(
    chat.failNext(
      "post",
      new ChatError.NotFound({ detail: "thread_not_found" }),
      // A thread that is gone refuses the answer's second try too (DIS-54).
      { times: 2 },
    ),
  )
  await fakes.model.release(0)
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("ThreadGone")
  expect(rows(running, "SELECT outcome, failure FROM turns")).toEqual([
    { outcome: "failed", failure: "ThreadGone" },
  ])
  expect(running.log().map((line) => line.annotations["event"])).not.toContain(
    "turn.ended",
  )
  expect(rows(running, "SELECT * FROM session_updates")).toEqual([])
})

test("FAIL-110 FAIL-111 FAIL-114a CLI-149 chad status gives Problems and Recent, with the failed turns grouped by reason and the last of them by id, and still answers when the turns table cannot be read", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ status: 400 }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  const [failed] = await lines(running, "turn.failed", 1)
  const status = async () => {
    const result = await running.chad(["status", "--json"])
    expect(result.code).toBe(0)
    return JSON.parse(result.stdout)
  }
  const report = await status()
  expect(report.problems).toEqual([])
  expect(report.recent).toMatchObject({
    failed: [{ reason: "ModelError", count: 1 }],
    last: [{ turn: failed!.annotations["turn"], reason: "ModelError" }],
  })
  expect(report.started).toBeTypeOf("number")

  execute(running.data, "ALTER TABLE turns RENAME TO turns_gone")
  const broken = await status()
  expect(broken.phase).toBe("ready")
  expect(broken.recent.unavailable).toBeTypeOf("string")
})

test("FAIL-127 FAIL-215 FAIL-332 after two failed turns in a row the third turn's update message gives the latest in full and counts the older one by its reason, though the second turn's history cleared its line", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ status: 400 }, { status: 400 }, { text: "back" }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  await says(running, thread, "again")
  await fakes.chat.answers(thread, 2)
  const failed = await lines(running, "turn.failed", 2)
  const [one, two] = failed.map((line) => String(line.annotations["turn"]))
  // The second turn's history holds the first failure's line, so the line is gone.
  expect(rows(running, "SELECT turn_id FROM session_updates")).toEqual([
    { turn_id: two },
  ])

  await says(running, thread, "and again")
  await fakes.chat.answers(thread, 3)
  const update = Messages.update([
    { turn: one!, outcome: "failed", failure: "ModelError" },
    { turn: two!, outcome: "failed", failure: "ModelError" },
  ])
  const sent = userTexts((await fakes.model.calls())[2])
  expect(sent.at(-2)).toBe(update)
  expect(sent.at(-1)).toContain("and again")
  expect(rows(running, "SELECT * FROM session_updates")).toEqual([])
})
