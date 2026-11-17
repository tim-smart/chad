import { Effect } from "effect"
import { ChatError } from "effect/chat"
import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import * as Failed from "../../dist/daemon/Failed.js"
import { scenario } from "../support/driver.ts"
import type { Call } from "../support/model.ts"
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

test("a turn whose model request fails posts the failed-turn message with its turn id, logs turn.failed with ModelError and records the whole reason, and the next turn tells the model in one update message ahead of the owner's, whose line is cleared with the history that holds it", async () => {
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

test("a turn that answered adds nothing for the next turn, and an answer whose post failed twice is logged as turn.answer-unposted, stays answered and is told to the model at the next turn", async () => {
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
