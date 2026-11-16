// A kill on each side of the steer commit: the transaction that stores the batch of steering messages in the history
// together with their steers rows.
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { runs } from "../support/model.ts"
import { lines, posted, prompted, rows, says } from "../support/owner.ts"
import { daemon, type Process } from "../support/process.ts"

/** How many stored history messages hold the text. */
const stored = (running: Process, text: string) =>
  rows(running, "SELECT message FROM session_messages").filter((row) =>
    String(row["message"]).includes(text),
  ).length

/** The text of each user message a model call carries. */
const users = (call: { readonly body: unknown } | undefined) =>
  (
    (
      call?.body as {
        messages?: ReadonlyArray<{ role?: string; content?: unknown }>
      }
    )?.messages ?? []
  )
    .filter((message) => message.role === "user")
    .map((message) => String(message.content))

const steered = (running: Process) =>
  running.log().filter((line) => line.annotations["event"] === "turn.steered")

test("a kill before the steer commit leaves the message unrecorded, and after the restart the redelivered message steers the resumed turn and is in the history once", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    { text: "never sent", hold: true },
    runs('console.log("one")'),
    runs('console.log("two")'),
    { text: "finished" },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "first message")
  await fakes.model.received(1)
  await says(running, thread, "second message")
  await first.kill()
  expect(rows(running, "SELECT * FROM steers")).toEqual([])

  await running.start()
  await lines(running, "turn.steered", 1)
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["finished"])
  // The resumed start runs on the restart note, and the message joins it at its next step.
  const calls = await fakes.model.calls()
  const said = users(calls.at(-1))
  expect(said.filter((text) => text === Messages.restartNote())).toHaveLength(1)
  expect(said.filter((text) => text === "second message")).toHaveLength(1)
  expect(stored(running, "second message")).toBe(1)
  expect(rows(running, "SELECT COUNT(*) AS turns FROM turns")).toEqual([
    { turns: 1 },
  ])
  expect(rows(running, "SELECT COUNT(*) AS steers FROM steers")).toEqual([
    { steers: 1 },
  ])
}, 20_000)

test("a kill after the steer commit leaves the message recorded, and after the restart the message does not steer again and is in the history once", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    { ...runs('console.log("one")'), hold: true },
    { text: "never sent", hold: true },
    { text: "finished" },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "first message")
  await fakes.model.received(1)
  await says(running, thread, "second message")
  await fakes.model.release(0)
  await lines(running, "turn.steered", 1)
  await fakes.model.received(2)
  await first.kill()

  await running.start()
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["finished"])
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(3)
  expect(prompted(calls[2])).toBe(Messages.restartNote())
  expect(steered(running)).toHaveLength(1)
  expect(stored(running, "second message")).toBe(1)
  expect(rows(running, "SELECT COUNT(*) AS steers FROM steers")).toEqual([
    { steers: 1 },
  ])
}, 20_000)
