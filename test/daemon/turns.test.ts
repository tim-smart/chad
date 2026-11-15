import { Duration } from "effect"
import { expect, test } from "vitest"
import { defaults } from "../../dist/Timings.js"
import { scenario, type Scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import {
  eventually,
  found,
  lines,
  posted,
  rows,
  says,
  sessions,
} from "../support/owner.ts"

/** Waits until a statement gives a row, and gives the first. */
const row = async (running: Scenario, sql: string) => {
  const [first] = await found(running, sql)
  return first!
}

test("SES-88 STO-69 STO-70 STO-124 STO-164 STO-165 STO-206 FAIL-99 FAIL-100 FAIL-102 MOD-117 a turn has one row from its start, with its request, its session, the owner's message as origin and the whole model setting, and its end and outcome are null until it ends", async () => {
  const running = await scenario({
    env: { CHAD_MODEL: "openai-compat/fake/high" },
  })
  const { fakes } = running
  await fakes.model.script([{ text: "done", hold: true }])
  const thread = await fakes.chat.makeThread("direct")
  const before = Date.now()
  const hello = await says(running, thread, "hello")
  await fakes.model.received(1)

  const [session] = sessions(running)
  const started = await row(running, "SELECT * FROM turns")
  expect(started).toMatchObject({
    session_id: session?.["id"],
    origin: "message",
    origin_plugin: null,
    origin_label: null,
    ended_at: null,
    outcome: null,
    failure: null,
    failure_detail: null,
    starts: 1,
    graceful_cuts: 0,
    model: "openai-compat/fake/high",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    context_tokens: 0,
  })
  expect(String(started["request_key"])).toContain(hello.message.id)
  expect(started["turn_id"]).toMatch(/^t_[0-9a-f]{12}$/)
  expect(Number.isInteger(started["started_at"])).toBe(true)
  expect(started["started_at"]).toBeGreaterThanOrEqual(before)
  expect(started["started_at"]).toBeLessThanOrEqual(Date.now())

  await fakes.model.release(0)
  await fakes.chat.answers(thread, 1)
  const ended = await row(
    running,
    "SELECT * FROM turns WHERE outcome IS NOT NULL",
  )
  expect(ended).toMatchObject({
    request_key: started["request_key"],
    turn_id: started["turn_id"],
    started_at: started["started_at"],
    outcome: "answered",
    starts: 1,
    model: "openai-compat/fake/high",
  })
  expect(Number.isInteger(ended["ended_at"])).toBe(true)
  expect(ended["ended_at"]).toBeGreaterThanOrEqual(
    Number(started["started_at"]),
  )
  expect(ended["ended_at"]).toBeLessThanOrEqual(Date.now())
  // The log line of the turn carries the same ids as the row.
  const line = await running.logged("turn.ended")
  expect(line.annotations).toMatchObject({
    turn: started["turn_id"],
    session: session?.["id"],
  })
})

test("STO-125 STO-126 FAIL-101 FAIL-107 the turns table has an index on started_at and one on the session with started_at, counters that are never null, and no column for a cost", async () => {
  const running = await scenario()
  await running.logged("boot.ready")
  const indexes = rows(
    running,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turns' AND sql IS NOT NULL ORDER BY name",
  ).map((index) => String(index["sql"]).replace(/^.* ON /, ""))
  expect(indexes).toEqual([
    "turns (session_id, started_at)",
    "turns (started_at)",
  ])
  const columns = rows(running, "SELECT * FROM pragma_table_info('turns')")
  expect(columns.map((column) => column["name"])).toEqual([
    "request_key",
    "turn_id",
    "session_id",
    "origin",
    "origin_plugin",
    "origin_label",
    "started_at",
    "ended_at",
    "outcome",
    "failure",
    "failure_detail",
    "status_message_id",
    "starts",
    "graceful_cuts",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "context_tokens",
  ])
  const counters = columns.filter((column) =>
    /^(starts|graceful_cuts|.*_tokens)$/.test(String(column["name"])),
  )
  expect(counters).toHaveLength(7)
  for (const counter of counters) {
    expect(counter).toMatchObject({
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
    })
  }
})

test("FAIL-53 FAIL-103 FAIL-105 a turn's usage is the total of its model calls, a sub-agent's included, the output tokens include the reasoning tokens, and a script that fails goes back to the model as its output and does not fail the turn", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    {
      ...runs('await subagent({ prompt: "Fail." })'),
      usage: { input: 100, output: 20, cached: 40, reasoning: 5 },
    },
    // The sub-agent's two calls: a script that throws, and its end.
    {
      ...runs('throw new Error("the script failed")'),
      usage: { input: 1000, output: 200, cached: 400, reasoning: 50 },
    },
    {
      ...runs('await taskComplete("it failed")'),
      usage: { input: 2000, output: 300, cached: 1000 },
    },
    {
      text: "done",
      usage: { input: 150, output: 30, cached: 100, reasoning: 10 },
    },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)

  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(4)
  expect(String(results(calls[2])[0])).toContain("the script failed")
  expect(await posted(running, thread)).toEqual(["done"])
  const turn = await row(
    running,
    "SELECT * FROM turns WHERE outcome IS NOT NULL",
  )
  expect(turn).toMatchObject({
    outcome: "answered",
    failure: null,
    input_tokens: 3250,
    output_tokens: 550,
    cache_read_tokens: 1540,
    cache_write_tokens: 0,
    // What the turn's own last call read, and not a sum.
    context_tokens: 150,
  })
  const line = await running.logged("turn.ended")
  expect(line.annotations).toMatchObject({
    input_tokens: 3250,
    output_tokens: 550,
  })
})

test("STO-133b CLI-137d FAIL-108b chad db query reads the turns table with the daemon running and with none", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "done" }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  await running.logged("turn.ended")
  const sql = "SELECT origin, outcome FROM turns"
  const expected = [{ origin: "message", outcome: "answered" }]

  const up = await running.chad(["db", "query", "--json", sql])
  expect(up.code).toBe(0)
  expect(JSON.parse(up.stdout)).toEqual(expected)
  await running.stop()
  const down = await running.chad(["db", "query", "--json", sql])
  expect(down.code).toBe(0)
  expect(JSON.parse(down.stdout)).toEqual(expected)
})

test("SES-21 SES-89 SES-90 SES-159 SES-194 STO-74 STO-112 STO-168 TST-212 cluster deletes a completed request after the retention, the rows of the turn and of its steer stay, and the same event again is answered from the turn's row: no turn, no post, and a duplicate line", async () => {
  expect(Duration.toHours(defaults.messageRetention)).toBe(24)
  const running = await scenario({
    env: { CHAD_LOG_LEVEL: "debug" },
    timings: { messageRetention: Duration.millis(200) },
  })
  const { fakes } = running
  await fakes.model.script([
    { ...runs('console.log("ran")'), hold: true },
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  const hello = await says(running, thread, "hello")
  await fakes.model.received(1)
  const steer = await says(running, thread, "and this")
  await fakes.model.release(0)
  await fakes.chat.answers(thread, 1)
  const requests = "SELECT 1 FROM cluster_messages WHERE tag = 'message'"
  await eventually(
    () => rows(running, requests),
    (left) => left.length === 0,
  )
  const turns = rows(running, "SELECT * FROM turns")
  const steers = rows(running, "SELECT * FROM steers")
  expect(turns).toMatchObject([{ outcome: "answered" }])
  expect(steers).toHaveLength(1)

  // Cluster no longer knows either event, so each is saved again and reaches the session.
  for (const event of [hello, steer]) {
    expect(await fakes.chat.deliver(event)).toBe(true)
  }
  await eventually(
    () => lines(running, "message.ignored", 0),
    (ignored) =>
      ignored.filter((line) => line.annotations["reason"] === "duplicate")
        .length >= 2,
  )
  const answers = rows(
    running,
    `SELECT r.payload FROM cluster_replies r JOIN cluster_messages m ON m.id = r.request_id
     WHERE m.tag = 'message' ORDER BY r.rowid`,
  ).map((reply) => JSON.parse(String(reply["payload"])).value)
  if (answers.length > 0) {
    expect(answers).toContainEqual({ _tag: "Answered", text: "" })
  }
  expect(rows(running, "SELECT * FROM turns")).toEqual(turns)
  expect(rows(running, "SELECT * FROM steers")).toEqual(steers)
  expect(await posted(running, thread)).toEqual(["done"])
  expect(await fakes.model.calls()).toHaveLength(2)
  expect(
    running
      .log()
      .filter((line) => line.annotations["event"] === "turn.started"),
  ).toHaveLength(1)
})
