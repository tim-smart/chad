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

test("SES-133 DIS-61 FAIL-84 FAIL-203 FAIL-204 FAIL-205 FAIL-57 API-113 TST-181 TST-215 a model call that says nothing for three of real clanka's turn timeouts in a row ends the turn as ModelError with chad's reason TurnTimeout and the silence message", async () => {
  const running = await scenario({
    timings: { turnTimeout: Duration.millis(400) },
  })
  const { fakes } = running
  // A fourth call would be answered with an error that is no timeout, which would end the turn some other way.
  await fakes.model.script([{ hold: true }, { hold: true }, { hold: true }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")

  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("ModelError")
  const reason = recorded(running)
  expect(reason).toMatchObject({
    _tag: "ModelError",
    reason: "TurnTimeout",
    retries: 3,
  })
  if (reason._tag !== "ModelError") throw new Error("not a ModelError")
  // The first two timeouts were retried, and the third ended the turn.
  expect(
    running.log().filter((line) => line.annotations["event"] === "turn.retry"),
  ).toHaveLength(2)
  const [message] = await eventually(
    () => posted(running, thread),
    (texts) => texts.length > 0,
  )
  expect(message).toBe(
    Messages.failedTurn(
      Format.local,
      Number(failed!.annotations["duration_ms"]),
      reason,
      String(failed!.annotations["turn"]),
    ),
  )
  expect(message).toContain(Messages.silenceReason)
})

test("MOD-102 MOD-103 FAIL-212 turn timeouts while a login is pending for the session do not count toward the silence bound, and the count starts again from zero once the login completes", async () => {
  const running = await scenario({
    ...codex,
    codex: "token",
    timings: { turnTimeout: Duration.millis(800) },
  })
  const { fakes, model } = running
  model.holdPolls()
  // The first call says nothing, and its retry needs a new socket and so the token the logout takes. After the login
  // two more calls say nothing: with the timeout before the login they would be three in a row.
  await fakes.model.script([
    { hold: true },
    { hold: true },
    { hold: true },
    { text: "carried on" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(1)
  expect((await running.cli(["logout"])).code).toBe(0)
  // The logout came before the first timeout, so the retry is the one that needs the login.
  expect(
    running.log().filter((line) => line.annotations["event"] === "turn.retry"),
  ).toHaveLength(0)
  // The fake holds the poll until the approval, so the login stays pending for as many timeouts as the test waits for.
  // Two of them, with the one before the login, would have ended the turn if they counted.
  await lines(running, "turn.login-wait", 1)
  await eventually(
    () => running.log().map((line) => line.annotations["event"]),
    (events) =>
      events.includes("turn.failed") ||
      events
        .slice(events.indexOf("turn.login-wait"))
        .filter((event) => event === "turn.retry").length >= 2,
  )
  model.approve()

  const [turn] = await eventually(
    () => rows(running, "SELECT outcome FROM turns"),
    (all) => all[0]?.["outcome"] != null,
  )
  expect(turn?.["outcome"]).toBe("answered")
  await eventually(
    () => posted(running, thread),
    (texts) => texts.includes("carried on"),
  )
  // The two calls after the login said nothing too, and the third answered.
  expect(model.calls()).toHaveLength(4)
  // At least two timeouts came while the login was pending, which with the one before it would have ended the turn.
  const events = running.log().map((line) => line.annotations["event"])
  const pending = events.slice(
    events.indexOf("turn.login-wait"),
    events.indexOf("model.logged-in"),
  )
  expect(
    pending.filter((event) => event === "turn.retry").length,
  ).toBeGreaterThanOrEqual(2)
})

test("FAIL-46 FAIL-87 FAIL-88 FAIL-97 FAIL-60 DIS-104 FAIL-242 MOD-114 FAIL-94 FAIL-319 FAIL-308 a usage limit on the Codex socket ends the turn at its first retry as UsageLimit, replies with the usage-limit message and no reset time, logs one turn.failed and no retry, records the usage-limit row that chad status lists and sends no notice, and the next model call that succeeds clears it", async () => {
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

test("FAIL-90 FAIL-206 FAIL-209 FAIL-321 FAIL-342 FAIL-G38 a usage limit over HTTP, on openai with an API key, carries its reset time to the turn.failed line, the row, the message and the line under Problems", async () => {
  const running = await scenario({
    env: {
      CHAD_MODEL: "openai/gpt-6-astra/medium",
      CHAD_OPENAI_API_KEY: "fake-key",
    },
  })
  const { fakes } = running
  const seconds = 1_900_000_000
  await fakes.model.script([
    {
      status: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_at: seconds,
      },
    },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")

  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("UsageLimit")
  expect(failed!.annotations["resets_at"]).toBe(
    new Date(seconds * 1000).toISOString(),
  )
  expect(recorded(running)).toEqual({
    _tag: "UsageLimit",
    resetsAt: seconds * 1000,
  })
  expect(
    await eventually(
      () => posted(running, thread),
      (texts) => texts.length > 0,
    ),
  ).toEqual([Messages.usageLimitReached(Format.local, seconds * 1000)])
  const status = await running.chad(["status"])
  expect(status.stdout).toContain(Messages.usageLimitNotice(seconds * 1000))
})

/** The root agent starts a background sub-agent and waits for it, so the sub-agent's calls are the next ones. */
const behind =
  runs(`const behind = await subagent({ prompt: "Behind.", background: true })
await waitTasks({ ids: [behind.id] })`)

/** What the turn would do if chad let a background sub-agent's call go on: the sub-agent ends and the root answers. */
const carriedOn = [runs('await taskComplete("done")'), { text: "answered" }]

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

test("FAIL-84 FAIL-57 a background sub-agent's model call that says nothing for three turn timeouts in a row ends the owner's turn as TurnTimeout before a fourth attempt, with no retry line", async () => {
  const running = await scenario({
    timings: { turnTimeout: Duration.millis(400) },
  })
  const { fakes } = running
  await fakes.model.script([
    behind,
    { hold: true },
    { hold: true },
    { hold: true },
    ...carriedOn,
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")

  expect(await outcome(running)).toBe("failed")
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("ModelError")
  expect(recorded(running)).toMatchObject({
    _tag: "ModelError",
    reason: "TurnTimeout",
    retries: 3,
  })
  // The root's call and the sub-agent's three: chad ended the turn where clanka would have sent the fourth.
  expect(running.model.calls()).toHaveLength(4)
  expect(retried(running)).toEqual([])
  const [message] = await eventually(
    () => posted(running, thread),
    (texts) => texts.length > 0,
  )
  expect(message).toContain(Messages.silenceReason)
})

test("FAIL-87 FAIL-88 a background sub-agent's usage limit on the Codex socket ends the owner's turn as UsageLimit at once, with no retry", async () => {
  const running = await scenario({ ...codex, codex: "token" })
  const { fakes } = running
  await fakes.model.script([
    behind,
    {
      status: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
      },
    },
    ...carriedOn,
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")

  expect(await outcome(running)).toBe("failed")
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("UsageLimit")
  expect(recorded(running)).toEqual({ _tag: "UsageLimit" })
  expect(running.model.calls()).toHaveLength(2)
  expect(retried(running)).toEqual([])
  expect(
    await eventually(
      () => posted(running, thread),
      (texts) => texts.length > 0,
    ),
  ).toEqual([Messages.usageLimitReached(Format.local)])
})

test("FAIL-89 a background sub-agent's usage_not_included error ends the owner's turn at once as ModelError with its message", async () => {
  const running = await scenario({ ...codex, codex: "token" })
  const { fakes } = running
  await fakes.model.script([
    behind,
    {
      status: 403,
      error: {
        type: "usage_not_included",
        message: "The plan does not include the usage",
      },
    },
    ...carriedOn,
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")

  expect(await outcome(running)).toBe("failed")
  const [failed] = await lines(running, "turn.failed", 1)
  expect(failed!.annotations["reason"]).toBe("ModelError")
  const reason = recorded(running)
  expect(reason).toMatchObject({ _tag: "ModelError" })
  if (reason._tag !== "ModelError") throw new Error("not a ModelError")
  expect(reason.message).toContain("The plan does not include the usage")
  expect(running.model.calls()).toHaveLength(2)
  expect(retried(running)).toEqual([])
})

/** A usage limit on the Codex socket, as the fake model sends one. */
const limited = {
  status: 429,
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
  },
}

/** The `holds` of each notices row, by key. */
const holding = (running: Scenario) =>
  Object.fromEntries(
    rows(running, "SELECT key, holds FROM notices").map((row) => [
      row["key"],
      row["holds"],
    ]),
  )

test("FAIL-94 FAIL-235 the next model call that succeeds clears the usage limit and a failed check at start, also when it is a later call of a turn whose first call succeeded before the condition began", async () => {
  let loaded!: () => void
  const running = await scenario({
    ...codex,
    codex: "token",
    loading: new Promise<void>((resolve) => (loaded = resolve)),
  })
  const { fakes, model } = running
  // The check at start waits for the connection, which waits for `loaded`, so it is held before it is sent.
  const check = model.holdChecks("gpt-6-astra")
  model.failChecks(500)
  await fakes.model.script([
    runs('console.log("first")'),
    { text: "first is done", hold: true },
    limited,
  ])
  loaded()
  await check.reached

  // A's first call succeeds, and A waits on its next one.
  const first = await fakes.chat.makeThread("direct")
  await says(running, first, "hello")
  await model.received(2)
  // B hits the usage limit, and the check at start fails, while A waits.
  const second = await fakes.chat.makeThread("direct")
  await says(running, second, "hi")
  await lines(running, "turn.failed", 1)
  check.release()
  await lines(running, "model.check-failed", 1)
  expect(
    await eventually(
      () => holding(running),
      (held) => held["model-check-failed"] === 1,
    ),
  ).toEqual({ "usage-limit": 1, "model-check-failed": 1 })

  // A's next call succeeds, and the answer goes after the call's usage, so both rows are clear by then.
  model.release(1)
  await eventually(
    () => posted(running, first),
    (texts) => texts.includes("first is done"),
  )
  expect(holding(running)).toEqual({
    "usage-limit": 0,
    "model-check-failed": 0,
  })
})

test("FAIL-94 FAIL-87 a background sub-agent's model call that succeeds clears the usage limit, although its parts are not in the turn's output", async () => {
  const running = await scenario({ ...codex, codex: "token" })
  const { fakes, model } = running
  await fakes.model.script([
    behind,
    { ...runs('console.log("child")'), hold: true },
    limited,
    runs('await taskComplete("done")'),
    { text: "answered" },
  ])
  const first = await fakes.chat.makeThread("direct")
  await says(running, first, "hello")
  // The sub-agent's call waits while another turn hits the usage limit.
  await model.received(2)
  const second = await fakes.chat.makeThread("direct")
  await says(running, second, "hi")
  await lines(running, "turn.failed", 1)
  expect(
    await eventually(
      () => holding(running),
      (held) => held["usage-limit"] === 1,
    ),
  ).toMatchObject({ "usage-limit": 1 })

  // The sub-agent's call succeeds and it makes its next one. The root's call is still in its script, which waits for
  // the sub-agent, so only the sub-agent's call can have cleared the row by then.
  model.release(1)
  await model.received(4)
  expect(holding(running)).toMatchObject({ "usage-limit": 0 })
  await fakes.chat.answers(first, 1)
})

test("FAIL-235 FAIL-94 a model call that succeeds clears a failed check at start on a provider that reports no usage", async () => {
  let loaded!: () => void
  const running = await scenario({
    loading: new Promise<void>((resolve) => (loaded = resolve)),
  })
  const { fakes, model } = running
  model.failChecks(500)
  loaded()
  await lines(running, "model.check-failed", 1)
  await eventually(
    () => holding(running),
    (held) => held["model-check-failed"] === 1,
  )
  model.failChecks(undefined)
  await fakes.model.script([{ text: "unmetered", unmetered: true }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await eventually(
    () => posted(running, thread),
    (texts) => texts.includes("unmetered"),
  )
  expect(holding(running)).toEqual({ "model-check-failed": 0 })
})
