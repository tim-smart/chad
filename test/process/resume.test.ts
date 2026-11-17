// The resumed turn and the give-up in layer 4: the daemon as a child process that a scenario kills and starts again on
// the same volume. A kill point is a model response the fake holds.
import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import { execute } from "../support/database.ts"
import {
  found,
  lines,
  posted,
  prompted,
  rows,
  says,
  statusMessages,
} from "../support/owner.ts"
import { daemon } from "../support/process.ts"

test("a turn that a kill cut is delivered again at the next start with no word from the owner, counts a second start before the model runs, resumes with the restart note over the restored history and the first attempt's turn id, and adds its usage to what the killed attempt used", async () => {
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

test("after two starts that a kill ended, a SIGTERM followed by a kill before the cut counting as one, the next delivery counts a third start, runs no model, posts the give-up message and records the turn as failed with GaveUp, with only turn.failed for that delivery, and removes the status message the turn left behind", async () => {
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
    Messages.gaveUp(Format.local, String(failed!.annotations["turn"])),
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

test("a turn whose end the full volume cannot write gets the ordinary failed-turn message and no reply, the thread's later messages still answer, and a restart resumes it as a turn a crash cut", async () => {
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
  expect(told).toContain(Messages.turnLine(Format.local, turn))
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
