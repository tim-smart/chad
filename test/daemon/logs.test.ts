import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { type LogLine, scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { lines, says } from "../support/owner.ts"

/** A line of the log with a message, once it is there. */
const message = (log: ReadonlyArray<LogLine>, text: string) =>
  log.find((line) => line.message === text)

test("FAIL-23 FAIL-25 FAIL-26 FAIL-29 FAIL-241 FAIL-245 FAIL-246 FAIL-247 FAIL-248 a turn's scripts and its sub-agent get their lines with the session and the turn, the model reads clanka's own lines as plain clanka prints them, and their copies are capped at Info", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    runs('await ls("."); await subagent({ prompt: "Fail." })'),
    // The sub-agent's two calls: a script that throws, and its end.
    runs('throw new Error("the script failed")'),
    runs('await taskComplete("it failed")'),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  const ended = await running.logged("turn.ended")
  const ids = {
    session: ended.annotations["session"],
    turn: ended.annotations["turn"],
  }

  // The model reads the line of a built-in tool and a failing script's error in the scripts' output.
  const calls = await fakes.model.calls()
  expect(String(results(calls[3])[0])).toContain('Calling "ls"')
  expect(String(results(calls[2])[0])).toContain("the script failed")

  const log = running.log()
  // The copies carry the session and the turn, and clanka's Fatal line of the failing script is at Info.
  expect(message(log, 'Calling "ls"')).toMatchObject({
    level: "INFO",
    annotations: { ...ids, directory: "." },
  })
  const failure = log.find((line) =>
    String((line as { cause?: unknown }).cause ?? "").includes(
      "the script failed",
    ),
  )
  expect(failure).toMatchObject({ level: "INFO", annotations: ids })
  expect(log.some((line) => line.level === "FATAL")).toBe(false)

  const events = (name: string) =>
    log.filter((line) => line.annotations["event"] === name)
  const [started] = events("turn.subagent-started")
  const subagent = started?.annotations["subagent"]
  expect(typeof subagent).toBe("number")
  expect(events("turn.subagent-ended")).toMatchObject([
    { annotations: { ...ids, subagent, status: "completed" } },
  ])
  // The failing script is the sub-agent's, so clanka's line of its failure carries the sub-agent's id.
  expect(failure?.annotations["subagent"]).toBe(subagent)
  // The root's script carries no sub-agent, and the sub-agent's carry its id.
  expect(events("turn.script-started")).toMatchObject([
    { annotations: { ...ids, source: expect.stringContaining('ls(".")') } },
    {
      annotations: {
        ...ids,
        subagent,
        source: expect.stringContaining("the script failed"),
      },
    },
    { annotations: { ...ids, subagent } },
  ])
  expect(events("turn.script-started")[0]?.annotations).not.toHaveProperty(
    "subagent",
  )
  // The root's script ends last, after the sub-agent it waited for.
  const scripts = events("turn.script-ended")
  expect(scripts).toHaveLength(3)
  expect(scripts[2]?.annotations).not.toHaveProperty("subagent")
  expect(scripts[0]?.annotations).toMatchObject({ ...ids, subagent })
  expect(String(scripts[0]?.annotations["output"])).toContain(
    "the script failed",
  )
  expect(typeof scripts[0]?.annotations["duration_ms"]).toBe("number")
})

test("FAIL-13 FAIL-14 FAIL-192 FAIL-241 FAIL-328 the scripts of a foreground and of a background sub-agent get their source, output, start and end lines, and every line of those scripts carries the sub-agent's id, the copied tool lines included", async () => {
  const running = await scenario()
  const { fakes } = running
  const child = 'console.log("SUB-OUTPUT"); await ls(".")'
  await fakes.model.script([
    runs(`await subagent({ prompt: "In front." })
const behind = await subagent({ prompt: "Behind.", background: true })
await waitTasks({ ids: [behind.id] })`),
    // Each sub-agent runs its script, and then it is done.
    runs(child),
    runs('await taskComplete("done")'),
    runs(child),
    runs('await taskComplete("done")'),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  await running.logged("turn.ended")

  const log = running.log()
  const events = (name: string) =>
    log.filter((line) => line.annotations["event"] === name)
  const started = events("turn.subagent-started")
  const front = started.find((line) => line.annotations["background"] === false)
    ?.annotations["subagent"]
  const behind = started.find((line) => line.annotations["background"] === true)
    ?.annotations["subagent"]
  expect(typeof front).toBe("number")
  expect(typeof behind).toBe("number")
  for (const subagent of [front, behind]) {
    expect(events("turn.script-started")).toContainEqual(
      expect.objectContaining({
        annotations: expect.objectContaining({
          subagent,
          source: expect.stringContaining("SUB-OUTPUT"),
        }),
      }),
    )
    expect(events("turn.script-ended")).toContainEqual(
      expect.objectContaining({
        annotations: expect.objectContaining({
          subagent,
          output: expect.stringContaining("SUB-OUTPUT"),
        }),
      }),
    )
  }
  // Both children's scripts start and end, and so does the root's, which carries no sub-agent. Each child ends once.
  expect(events("turn.subagent-ended")).toHaveLength(2)
  expect(events("turn.script-started")).toHaveLength(5)
  expect(events("turn.script-ended")).toHaveLength(5)
  expect(events("turn.script-started")[0]?.annotations).not.toHaveProperty(
    "subagent",
  )
  const calls = log.filter((line) => line.message === 'Calling "ls"')
  expect(calls.map((line) => line.annotations["subagent"]).sort()).toEqual(
    [front, behind].sort(),
  )
  // The root's script output, which the model reads, has none of the children's lines.
  const read = String(results((await fakes.model.calls())[5])[0])
  expect(read).toContain('Calling "subagent"')
  expect(read).not.toContain("SUB-OUTPUT")
  const root = log.filter((line) => line.message === 'Calling "subagent"')
  expect(root.length).toBeGreaterThan(0)
  for (const line of root)
    expect(line.annotations).not.toHaveProperty("subagent")
})

test("FAIL-15 FAIL-250 the root's and a foreground sub-agent's retried model calls get one turn.retry line each, the sub-agent's with its id", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    // The root's call fails once, and so does the sub-agent's first call.
    { status: 500 },
    runs('await subagent({ prompt: "In front." })'),
    { status: 500 },
    runs('await taskComplete("done")'),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  await running.logged("turn.ended")

  const log = running.log()
  const events = (name: string) =>
    log.filter((line) => line.annotations["event"] === name)
  const front = events("turn.subagent-started")[0]?.annotations["subagent"]
  expect(typeof front).toBe("number")
  const retries = events("turn.retry")
  expect(retries).toHaveLength(2)
  expect(retries[0]?.annotations).not.toHaveProperty("subagent")
  expect(retries[1]?.annotations).toMatchObject({ subagent: front, retry: 1 })
  for (const line of retries) {
    expect(line.level).toBe("WARN")
    expect(typeof line.annotations["reason"]).toBe("string")
    expect(typeof line.annotations["error"]).toBe("string")
  }
  expect(events("turn.subagent-ended")).toHaveLength(1)
})

test("FAIL-15 FAIL-250 a background sub-agent's empty response that clanka takes, followed by its taskComplete, logs no turn.retry", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    runs(`const behind = await subagent({ prompt: "Behind.", background: true })
await waitTasks({ ids: [behind.id] })`),
    { text: "" },
    runs('await taskComplete("done")'),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  await running.logged("turn.ended")

  const log = running.log()
  const events = (name: string) =>
    log.filter((line) => line.annotations["event"] === name)
  expect(events("turn.subagent-ended")).toHaveLength(1)
  expect(events("turn.retry")).toEqual([])
})

test("FAIL-249 FAIL-241 a background sub-agent that compacts its history gets its turn.compaction line with the sub-agent's id", async () => {
  const running = await scenario()
  const { fakes } = running
  // The sub-agent's calls after its first carry a tool result, and its summarizer's do not, so either can take them.
  const step = {
    ...runs('console.log("more")'),
    summary: { text: "The story so far." },
  }
  await fakes.model.script([
    runs(`const behind = await subagent({ prompt: "a long story. ".repeat(8_000), background: true })
await waitTasks({ ids: [behind.id] })`),
    // The sub-agent's context is over clanka's threshold after its first call, which starts a compaction.
    { ...runs('console.log("ran")'), usage: { input: 250_000, output: 10 } },
    // Its next call and its summarizer's, in either order. Its own is held until the summarizer has been called.
    { ...step, hold: true },
    { ...step, hold: true },
    step,
    step,
    step,
    runs('await taskComplete("done")'),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(4)
  await fakes.model.release(2)
  await fakes.model.release(3)
  await fakes.chat.answers(thread, 1)
  await running.logged("turn.ended")

  const log = running.log()
  const events = (name: string) =>
    log.filter((line) => line.annotations["event"] === name)
  const behind = events("turn.subagent-started")[0]?.annotations["subagent"]
  expect(typeof behind).toBe("number")
  expect(events("turn.compaction")).toMatchObject([
    { annotations: { subagent: behind } },
  ])
  // Its calls after one that was taken, the one on the compacted history included, are no retries.
  expect(events("turn.retry")).toHaveLength(0)
})

test("FAIL-192 FAIL-193 FAIL-246 FAIL-248 a /stop while a script waits on its sub-agent logs one script end with the output so far and one sub-agent end, each with its duration", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    runs('console.log("PARTIAL"); await subagent({ prompt: "Wait." })'),
    // The sub-agent's call never comes back, so the script waits.
    { text: "never", hold: true },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(2)
  await running.logged("turn.subagent-started")
  await says(running, thread, "/stop")
  const ended = await running.logged("turn.ended")
  expect(ended.annotations["outcome"]).toBe("stopped")

  const log = running.log()
  const events = (name: string) =>
    log.filter((line) => line.annotations["event"] === name)
  const subagent = events("turn.subagent-started")[0]?.annotations["subagent"]
  const scripts = await lines(running, "turn.script-ended", 1)
  const children = await lines(running, "turn.subagent-ended", 1)
  expect(scripts).toHaveLength(1)
  expect(String(scripts[0]?.annotations["output"])).toContain("PARTIAL")
  expect(typeof scripts[0]?.annotations["duration_ms"]).toBe("number")
  expect(children).toHaveLength(1)
  expect(children[0]?.annotations).toMatchObject({ subagent })
  expect(typeof children[0]?.annotations["duration_ms"]).toBe("number")
  await running.stop()
  const after = running.log()
  expect(
    after.filter((line) => line.annotations["event"] === "turn.script-ended"),
  ).toHaveLength(1)
  expect(
    after.filter((line) => line.annotations["event"] === "turn.subagent-ended"),
  ).toHaveLength(1)
})

/** Takes out what differs between two runs of one script: the clock and the fiber ids of effect's default format. */
const settled = (text: string) =>
  text
    .replaceAll(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/g, "[time]")
    .replaceAll(/#\d+/g, "#fiber")

test("TST-166 FAIL-19 FAIL-21 FAIL-22 the text the model reads from a script's output is byte-identical at every value of CHAD_LOG_LEVEL", async () => {
  const levels = [
    "all",
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
    "none",
  ]
  const read: Record<string, string> = {}
  for (const level of levels) {
    const running = await scenario({ env: { CHAD_LOG_LEVEL: level } })
    const { fakes } = running
    await fakes.model.script([
      runs('await ls("."); throw new Error("the script failed")'),
      { text: "done" },
    ])
    const thread = await fakes.chat.makeThread("direct")
    await says(running, thread, "hello")
    await fakes.chat.answers(thread, 1)
    const calls = await fakes.model.calls()
    read[level] = settled(String(results(calls[1])[0]))
    await running.stop()
  }
  expect(read["info"]).toContain('Calling "ls"')
  expect(read["info"]).toContain("the script failed")
  for (const level of levels) expect(read[level]).toBe(read["info"])
})

test("CLI-146 CLI-147 CLI-196 CLI-199 FAIL-38 FAIL-39 FAIL-40 FAIL-194 FAIL-200 FAIL-201 FAIL-202 chad logs filters the daemon's log by turn and event prefix, prints the stored lines with --json, exits 0 when nothing matches and 2 for a level or time it cannot read, and reads the log with no daemon", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "one" }, { text: "two" }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  const first = await running.logged("turn.ended")
  await says(running, thread, "again")
  await fakes.chat.answers(thread, 2)
  await running.logged(
    "turn.ended",
    (line) => line.annotations["turn"] !== first.annotations["turn"],
  )
  const turn = String(first.annotations["turn"])

  const stored = running
    .log()
    .filter((line) => line.annotations["turn"] === turn)
  const json = await running.chad(["logs", "--turn", turn, "--json"])
  expect(json.code).toBe(0)
  expect(
    json.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(stored)

  // Two filters together: the turn's own turn events, and nothing of the other turn or of the boot.
  const both = await running.chad(["logs", "--turn", turn, "--event", "turn."])
  expect(both.code).toBe(0)
  const printed = both.stdout.trim().split("\n")
  expect(printed).toHaveLength(
    stored.filter((line) =>
      String(line.annotations["event"]).startsWith("turn."),
    ).length,
  )
  expect(printed.every((line) => line.includes(`turn=${turn}`))).toBe(true)
  expect(printed.some((line) => line.includes("turn.started"))).toBe(true)

  const none = await running.chad(["logs", "--level", "error"])
  expect(none).toMatchObject({ code: 0, stdout: "" })
  const level = await running.chad(["logs", "--level", "loud"])
  expect(level.code).toBe(2)
  expect(level.stderr).toContain(Messages.logsLevel())
  const since = await running.chad(["logs", "--since", "yesterday"])
  expect(since.code).toBe(2)
  expect(since.stderr).toContain(Messages.logsSince())

  await running.stop()
  const after = await running.chad(["logs", "--turn", turn, "--json"])
  expect(after.code).toBe(0)
  expect(after.stdout.trim().split("\n")).toHaveLength(stored.length)
})
