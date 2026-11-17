// The status message of a running turn and its Stop button.
import { Effect } from "effect"
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

test("the status message is posted before the model runs with its id in the turn's row, gets a line for the script, keeps the Stop button through the edit, ignores a click from someone who is not an owner, and is removed before the answer", async () => {
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

test("a click on Stop from an owner is answered inside the interaction deadline and stops the turn as /stop does, and the status message is removed", async () => {
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
