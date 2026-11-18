import { Duration } from "effect"
import { expect, test } from "vitest"
import * as Failed from "../../dist/daemon/Failed.js"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import { type Options, type Scenario, scenario } from "../support/driver.ts"
import { runs } from "../support/model.ts"
import { eventually, lines, posted, rows, says } from "../support/owner.ts"

/** A daemon on the Codex login, which runs on the WebSocket transport. */
const codex = {
  env: {
    CHAD_MODEL: "openai/gpt-6-astra/medium",
    CHAD_OPENAI_API_KEY: undefined,
  },
} satisfies Options

/** The reason a scenario's only turn row records. */
const recorded = (running: Scenario) => {
  const [row] = rows(running, "SELECT failure, failure_detail FROM turns")
  return Failed.fromRow(
    String(row?.["failure"]),
    String(row?.["failure_detail"]),
  )
}

test("a usage limit on the Codex socket ends the turn at its first retry as UsageLimit, replies with the usage-limit message and no reset time, logs one turn.failed and no retry, records the usage-limit row that chad status lists and sends no notice, and the next model call that succeeds clears it", async () => {
  const running = await scenario({ ...codex, codex: "token" })
  const { fakes } = running
  await fakes.model.script([
    {
      status: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_at: 1_900_000_000,
      },
    },
    { text: "back" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")

  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("UsageLimit")
  // effect's WebSocket decoder drops the reset time, so neither the line nor the row has one.
  expect(failed!.annotations).not.toHaveProperty("resets_at")
  expect(recorded(running)).toEqual({ _tag: "UsageLimit" })
  expect(
    running.log().filter((line) => line.annotations["event"] === "turn.retry"),
  ).toEqual([])
  // The owner has the message in the thread, which is also where a notice would go, and gets nothing else.
  expect(
    await eventually(
      () => posted(running, thread),
      (texts) => texts.length > 0,
    ),
  ).toEqual([Messages.usageLimitReached(Format.local)])
  const [row] = rows(
    running,
    "SELECT holds, recorded_at, text, last_sent_at FROM notices WHERE key = 'usage-limit'",
  )
  expect(row).toMatchObject({
    holds: 1,
    text: Messages.usageLimitNotice(),
    last_sent_at: null,
  })
  const status = await running.chad(["status"])
  expect(status.stdout).toContain(
    Messages.heldProblem(
      Messages.usageLimitNotice(),
      Number(row?.["recorded_at"]),
    ),
  )

  await says(running, thread, "again")
  await fakes.chat.answers(thread, 2)
  expect(await posted(running, thread)).toEqual([
    Messages.usageLimitReached(Format.local),
    "back",
  ])
  const [cleared] = await eventually(
    () => rows(running, "SELECT holds FROM notices WHERE key = 'usage-limit'"),
    (all) => all[0]?.["holds"] === 0,
  )
  expect(cleared).toEqual({ holds: 0 })
})

/** The outcome of the scenario's only turn, once it has one. */
const outcome = async (running: Scenario) => {
  const [turn] = await eventually(
    () => rows(running, "SELECT outcome FROM turns"),
    (all) => all[0]?.["outcome"] != null,
  )
  return turn?.["outcome"]
}

const retried = (running: Scenario) =>
  running.log().filter((line) => line.annotations["event"] === "turn.retry")

test("a foreground sub-agent's turn timeouts count where its own call is cut, also when clanka holds its retries back behind another foreground sub-agent's answer and gives them as that agent's after the login completed: one silent call after the login does not end the turn, and the third does, and the retry lines name no agent and count the turn's retries", async () => {
  const running = await scenario({
    ...codex,
    codex: "token",
    timings: { turnTimeout: Duration.millis(400) },
  })
  const { fakes, model } = running
  model.holdPolls()
  // The markers are joined in the script, so only each sub-agent's own calls carry its marker.
  await fakes.model.script([
    runs(`await Promise.all([
  subagent({ description: "a sub-agent", prompt: "Long" + "-answer" }),
  subagent({ description: "a sub-agent", prompt: "Silent" + "-call" }),
])`),
  ])
  const long = model.route("Long-answer", [
    { stream: true },
    runs('await taskComplete("done")'),
    runs('await taskComplete("done")'),
  ])
  const silent = model.route(
    "Silent-call",
    Array.from({ length: 8 }, () => ({ hold: true })),
  )
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  // A's answer streams and holds clanka's output, so B's parts wait in clanka's buffer from here on.
  const [streaming] = await long.received(1)
  // B's second call is out before its first timeout's retry part could show, and the logout comes before the second cut,
  // so the retry after it needs the login.
  await silent.received(2)
  expect((await running.cli(["logout"])).code).toBe(0)
  await lines(running, "turn.login-wait", 1)
  model.approve()
  // After the login B's call says nothing once more, and its next attempt is held here while A still streams.
  await silent.received(4)
  // clanka has shown none of B's retries yet: they are behind A's answer.
  expect(retried(running)).toEqual([])
  model.release(streaming!.index)

  // clanka gives B's held-back retries as A's when A's answer ends. One timeout came after the login, so the turn goes
  // on, and A completes. A turn that failed here would have ended A as cancelled.
  const started = await lines(running, "turn.subagent-started", 2)
  const a = started.find((line) =>
    String(line.annotations["prompt"]).includes("Long"),
  )?.annotations["subagent"]
  const events = await eventually(
    () => running.log(),
    (log) =>
      log.some(
        (line) =>
          line.annotations["event"] === "turn.failed" ||
          (line.annotations["event"] === "turn.subagent-ended" &&
            line.annotations["subagent"] === a &&
            line.annotations["status"] === "completed"),
      ),
  )
  expect(
    events.filter((line) => line.annotations["event"] === "turn.failed"),
  ).toEqual([])
  // B's call goes on saying nothing, and its third timeout in a row after the login ends the turn.
  expect(await outcome(running)).toBe("failed")
  expect(recorded(running)).toMatchObject({
    _tag: "ModelError",
    reason: "TurnTimeout",
  })
  // The thread's first post is the login's code.
  await eventually(
    () => posted(running, thread),
    (texts) => texts.some((text) => text.includes(Messages.silenceReason)),
  )
  // clanka gives B's held-back parts as A's, so a retry line names no agent, and its count is the turn's: it counts up
  // from the first retry, B's flushed parts and A's `Usage` included.
  const shown = retried(running)
  expect(shown.length).toBeGreaterThanOrEqual(3)
  for (const line of shown)
    expect(line.annotations).not.toHaveProperty("subagent")
  expect(shown.map((line) => line.annotations["retry"])).toEqual(
    shown.map((_, index) => index + 1),
  )
})
