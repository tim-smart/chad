// The status message of a running turn and its Stop button (docs/spec/04-discord.md), in layer 3.
import { Effect } from "effect"
import { ChatError } from "effect/chat"
import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import { owner, scenario } from "../support/driver.ts"
import {
  eventually,
  found,
  lines,
  posted,
  rows,
  says,
  statusMessages,
  stoppedNotices,
} from "../support/owner.ts"

const stranger = "someone-else"
const script = 'console.log("one")'

test("DIS-19 DIS-20 DIS-21 DIS-24 DIS-33 DIS-35 DIS-81 DIS-90 FAIL-11 STO-75 OV-28 SES-75 DIS-40 the status message is posted before the model runs with its id in the turn's row, gets a line for the script, keeps the Stop button through the edit, ignores a click from someone who is not an owner, and is removed before the answer", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    { tool: { name: "execute", arguments: { script } } },
    { text: "done", hold: true },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "count the files")
  await fakes.model.received(2)
  const [row] = await found(
    running,
    "SELECT started_at, status_message_id FROM turns WHERE status_message_id IS NOT NULL",
  )
  const [status] = await fakes.chat.statuses()
  expect(row!["status_message_id"]).toBe(status)
  const at = Number(row!["started_at"])
  await eventually(
    () => statusMessages(running, thread),
    (texts) =>
      texts[0] ===
      Messages.statusMessage(Format.local, at, [Messages.statusScript(script)]),
  )
  await lines(running, "turn.script-started", 1)

  // The edit sent the button again, so a click finds it. A click from someone who is not an owner is answered and
  // stops nothing.
  const ignored = await Effect.runPromise(
    running.click(status!, "stop", stranger),
  )
  expect(ignored._tag).toBe("Ack")
  await fakes.model.release(1)
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["done"])
  expect(await statusMessages(running, thread)).toEqual([])
  expect(await fakes.chat.statuses()).toHaveLength(1)
  expect(rows(running, "SELECT outcome FROM turns")).toEqual([
    { outcome: "answered" },
  ])
})

test("SES-74 DIS-39 a click on Stop from an owner is answered inside the interaction deadline and stops the turn as /stop does, and the status message is removed", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "never sent", hold: true }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "do the thing")
  await fakes.model.received(1)
  const [status] = await fakes.chat.statuses()

  // The fake answers `Late` for a click whose answer misses the 3 seconds.
  const reply = await Effect.runPromise(running.click(status!, "stop", owner))
  expect(reply._tag).toBe("Ack")
  const [notice] = await fakes.chat.answers(thread, 1)
  expect(
    stoppedNotices((milliseconds) =>
      Messages.stopped(Format.local, milliseconds),
    ),
  ).toContain(notice?.text)
  expect(await statusMessages(running, thread)).toEqual([])
  expect(rows(running, "SELECT outcome FROM turns")).toEqual([
    { outcome: "stopped" },
  ])
})

test("FAIL-207 DIS-94 a status message post that finds the thread gone ends the turn as ThreadGone before the model runs, and posts nothing", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([{ text: "never sent" }])
  const thread = await fakes.chat.makeThread("direct")
  await Effect.runPromise(
    chat.failNext(
      "post",
      new ChatError.NotFound({ detail: "thread_not_found" }),
    ),
  )
  await says(running, thread, "hello")
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("ThreadGone")
  expect(await fakes.model.calls()).toEqual([])
  expect(rows(running, "SELECT outcome, failure FROM turns")).toEqual([
    { outcome: "failed", failure: "ThreadGone" },
  ])
  expect(await posted(running, thread)).toEqual([])
})
