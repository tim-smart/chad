// The resumed turn and the give-up in layer 4: the daemon as a child process that a scenario kills and starts again
// on the same volume (docs/spec/17-testing.md, TST-27). A kill point is a model response the fake holds (TST-45).
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { found, lines, posted, prompted, rows, says } from "../support/owner.ts"
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
