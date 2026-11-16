import { expect, test } from "vitest"
import { execute } from "../support/database.ts"
import { scenario, type Scenario } from "../support/driver.ts"
import { runs } from "../support/model.ts"
import { lines, posted, rows, says, sessions } from "../support/owner.ts"

/** The stored history of a scenario's one session, in order, as it is written. */
const stored = (running: Scenario) =>
  rows(running, "SELECT seq, message FROM session_messages ORDER BY seq").map(
    (row) => String(row["message"]),
  )

/** The roles of a stored history. */
const roles = (history: ReadonlyArray<string>) =>
  history.map((message) => JSON.parse(message).role as string)

/** The messages of a model call, without the system prompt. */
const sent = (call: { readonly body: unknown } | undefined) => {
  const body = call?.body as
    { messages: ReadonlyArray<{ role: string; content: unknown }> } | undefined
  return (body?.messages ?? []).filter((message) => message.role !== "system")
}

test("the history is stored batch by batch while the turn runs, as clanka produced it and with nothing masked, and each batch carries the environment of that moment", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    runs('await changeDirectory("/tmp"); console.log("moved")'),
    { text: "done", hold: true },
    { text: "again" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  const secret = "the token is sk-live-0123456789abcdef"
  await says(running, thread, secret)
  await fakes.model.received(2)

  // The turn has not ended, and what it has produced so far is stored: the prompt, the call and its result.
  const during = stored(running)
  expect(roles(during)).toEqual(["user", "assistant", "tool"])
  expect(during[0]).toContain(secret)
  expect(during[2]).toContain("moved")
  const [session] = sessions(running)
  expect(String(session?.["environment"])).toContain("/tmp")

  await fakes.model.release(1)
  await fakes.chat.answers(thread, 1)
  await running.logged("turn.ended")
  const after = stored(running)
  expect(after.slice(0, 3)).toEqual(during)
  expect(roles(after)).toEqual(["user", "assistant", "tool", "assistant"])

  // The next turn adds rows and rewrites none, and the model gets back what was stored.
  await says(running, thread, "more")
  await fakes.chat.answers(thread, 2)
  await lines(running, "turn.ended", 2)
  const later = rows(
    running,
    "SELECT seq, message FROM session_messages ORDER BY seq",
  )
  expect(later.slice(0, 4).map((row) => row["message"])).toEqual(after)
  expect(later).toHaveLength(6)
  const calls = await fakes.model.calls()
  expect(JSON.stringify(sent(calls[2]))).toContain(secret)
})

test("a compaction swaps the session's rows for the compacted history, its summarizer outlives the turn that started it, and the summarizer's tokens are not in the turn's usage", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    // The call says the context is over clanka's threshold, which starts a compaction after the script.
    {
      ...runs('console.log("ran")'),
      usage: { input: 250_000, output: 10 },
    },
    // The next two calls are the turn's own and the summarizer's, in either order, and both are held.
    { text: "fine", hold: true, usage: { input: 7, output: 3 } },
    { text: "fine", hold: true, usage: { input: 7, output: 3 } },
    ...Array.from({ length: 8 }, () => ({ text: "two" })),
  ])
  const thread = await fakes.chat.makeThread("direct")
  // Long enough that clanka has something older than what a compaction keeps.
  const long = "a long story. ".repeat(8_000)
  await says(running, thread, long)
  const calls = await fakes.model.received(3)
  const summarizer = calls
    .slice(1)
    .findIndex((call) => sent(call).every((message) => message.role !== "tool"))
  expect(summarizer).toBeGreaterThanOrEqual(0)
  const own = summarizer === 0 ? 2 : 1

  // The turn ends while the summarizer is still at work.
  await fakes.model.release(own)
  await fakes.chat.answers(thread, 1)
  const ended = await running.logged("turn.ended")
  expect(ended.annotations).toMatchObject({
    input_tokens: 250_007,
    output_tokens: 13,
  })
  const before = stored(running)
  expect(before[0]).toContain("a long story.")

  // A turn takes a finished compaction before its model call. The summarizer ends at a time of its own, so the
  // owner goes on until a turn has taken it.
  await fakes.model.release(summarizer + 1)
  let turns = 1
  while (stored(running).join("").includes("a long story.")) {
    await says(running, thread, "next")
    turns++
    await fakes.chat.answers(thread, turns)
    await lines(running, "turn.ended", turns)
  }
  const after = stored(running)
  expect(after.join("")).not.toContain("a long story.")
  expect(after.join("")).toContain("fine")
  // The rows of the session were swapped: the oldest is no longer the one the first turn wrote.
  expect(after[0]).not.toBe(before[0])
  const last = (await fakes.model.calls()).at(-1)
  expect(JSON.stringify(sent(last))).not.toContain("a long story.")
  expect(await posted(running, thread)).toEqual([
    "fine",
    ...Array.from({ length: turns - 1 }, () => "two"),
  ])
  expect(
    rows(running, "SELECT input_tokens FROM turns ORDER BY started_at")[0],
  ).toEqual({ input_tokens: 250_007 })
})

test("at the end of a turn, however it ends, the stored history is made equal to the Agent's over the whole session before the end is recorded: a missing last row is written, a missing row of an earlier turn swaps them all, and the line of the turn's end carries the count", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    { text: "one" },
    { text: "never sent", hold: true },
    { text: "three", hold: true },
  ])
  const thread = await fakes.chat.makeThread("direct")
  const ends = (count: number) => lines(running, "turn.ended", count)
  const lost = (which: "min" | "max") =>
    execute(
      running.data,
      `DELETE FROM session_messages WHERE seq = (SELECT ${which}(seq) FROM session_messages)`,
    )
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  // A turn that had nothing to write says so.
  expect((await ends(1))[0]?.annotations["reconciled"]).toBe(0)
  const first = stored(running)
  expect(roles(first)).toEqual(["user", "assistant"])

  // The last row goes missing while the second turn runs, and the turn is stopped: the stored history is the
  // start of the Agent's, so the one message is written.
  await says(running, thread, "more")
  await fakes.model.received(2)
  expect(roles(stored(running))).toEqual(["user", "assistant", "user"])
  lost("max")
  await says(running, thread, "/stop")
  await fakes.chat.answers(thread, 2)
  const stopped = (await ends(2))[1]
  expect(stopped?.annotations).toMatchObject({
    outcome: "stopped",
    reconciled: 1,
  })
  const reconciled = await running.logged("history.reconciled")
  expect(reconciled.annotations["messages"]).toBe(1)
  const events = running.log().map((line) => line.annotations["event"])
  expect(events.indexOf("history.reconciled")).toBeLessThan(
    events.lastIndexOf("turn.ended"),
  )
  const second = stored(running)
  expect(roles(second)).toEqual(["user", "assistant", "user"])
  expect(second.slice(0, 2)).toEqual(first)
  expect(second[2]).toContain("more")

  // A row of the first turn goes missing while the third runs: the whole history is compared, and it is swapped.
  await says(running, thread, "and more")
  await fakes.model.received(3)
  lost("min")
  await fakes.model.release(2)
  await fakes.chat.answers(thread, 3)
  expect((await ends(3))[2]?.annotations).toMatchObject({
    outcome: "answered",
    reconciled: 6,
  })
  const third = stored(running)
  expect(third.slice(0, 3)).toEqual(second)
  // The stop is told to the model in an update message ahead of the owner's.
  expect(roles(third)).toEqual([
    "user",
    "assistant",
    "user",
    "user",
    "user",
    "assistant",
  ])
  expect(
    running
      .log()
      .filter((line) => line.annotations["event"] === "history.reconciled")
      .map((line) => line.annotations["messages"]),
  ).toEqual([1, 6])
  // What the turn's row says of its end was written after the history was whole.
  expect(
    rows(running, "SELECT outcome FROM turns ORDER BY started_at"),
  ).toEqual([
    { outcome: "answered" },
    { outcome: "stopped" },
    { outcome: "answered" },
  ])
})
