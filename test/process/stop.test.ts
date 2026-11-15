// The graceful stop in layer 4: SIGTERM to the daemon as a child process, its 15 second wait for the turns in flight,
// the cut at the end of it, and the next start on the same volume (docs/spec/03-sessions-and-turns.md).
import { expect, test } from "vitest"
import { lines, posted, rows, says } from "../support/owner.ts"
import { daemon } from "../support/process.ts"

test("SES-110 SES-112 SES-105 FAIL-122 FAIL-327 FAIL-294 FAIL-295 IMG-85a a graceful stop waits for the turn in flight, cuts it at the end of the wait with its finished steps stored, records the cut before it exits 0, and the cuts never count toward the give-up", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    { tool: { name: "execute", arguments: { script: 'console.log("one")' } } },
    { text: "never sent", hold: true },
    { text: "never sent", hold: true },
    { text: "never sent", hold: true },
    { text: "finished" },
  ])
  let current = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "count the files")
  // Two graceful cuts and a kill: two kills would end the turn, and the cuts do not count.
  for (const [index, end] of [
    [2, "stop"],
    [3, "stop"],
    [4, "kill"],
  ] as const) {
    await fakes.model.received(index)
    if (end === "kill") {
      await current.kill()
    } else {
      expect((await current.stop()).code).toBe(0)
      const cuts = index - 1
      expect(
        rows(running, "SELECT starts, graceful_cuts, outcome FROM turns"),
      ).toEqual([{ starts: cuts, graceful_cuts: cuts, outcome: null }])
    }
    current = await running.start()
  }
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["finished"])
  // The script the first start finished is in the stored history once, though the turn was cut three times.
  const stored = rows(running, "SELECT message FROM session_messages")
  expect(
    stored.filter((row) => String(row["message"]).includes("one")).length,
  ).toBeGreaterThan(0)
  const [ended] = await lines(running, "stop.ended", 2)
  const [started] = await lines(running, "stop.started", 2)
  expect(Date.parse(ended!.timestamp)).toBeGreaterThanOrEqual(
    Date.parse(started!.timestamp),
  )
  // The wait for requests in flight is 15 seconds, scaled.
  expect(ended!.annotations["duration_ms"]).toBeGreaterThanOrEqual(700)
  expect(
    rows(running, "SELECT starts, graceful_cuts, outcome FROM turns"),
  ).toEqual([{ starts: 4, graceful_cuts: 2, outcome: "answered" }])
}, 30_000)

test("SES-111 SES-201 FAIL-295 IMG-85a a turn that ends inside the wait of a graceful stop finishes and is not delivered again, and a message that arrives in the wait starts no turn and is answered at the next start", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([
    { text: "first answer", hold: true },
    { text: "second answer" },
    { text: "third answer" },
  ])
  const current = await running.start()
  const one = await fakes.chat.makeThread("direct")
  const two = await fakes.chat.makeThread("direct")
  await says(running, one, "first")
  await fakes.model.received(1)
  current.signal("SIGTERM")
  await running.logged("stop.started")
  const event = await fakes.chat.userPosts(two, {
    text: "second",
    authorId: "owner",
  })
  const delivered = fakes.chat.deliver(event)
  await fakes.model.release(0)
  await fakes.chat.answers(one, 1)
  expect((await current.exit).code).toBe(0)
  await running.logged("stop.ended")
  expect(await fakes.model.calls()).toHaveLength(1)

  await running.start()
  await fakes.chat.answers(two, 1)
  await delivered
  expect(await posted(running, two)).toEqual(["second answer"])
  await says(running, one, "again")
  await fakes.chat.answers(one, 2)
  expect(await posted(running, one)).toEqual(["first answer", "third answer"])
  expect(
    running.log().some((line) => line.annotations["event"] === "turn.resumed"),
  ).toBe(false)
  expect(
    rows(running, "SELECT starts, outcome FROM turns ORDER BY started_at"),
  ).toEqual([
    { starts: 1, outcome: "answered" },
    { starts: 1, outcome: "answered" },
    { starts: 1, outcome: "answered" },
  ])
}, 20_000)
