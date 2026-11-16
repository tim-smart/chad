// The bundled cron plugin as the model reaches it through its five tools, and as its jobs run, fail and are reconciled
// with the core's timers (docs/spec/13-timers-and-cron.md).
import { Effect } from "effect"
import { ChatError } from "effect/chat"
import { expect, test } from "vitest"
import { bundled } from "../../dist/Bundled.js"
import { scenario, type Scenario } from "../support/driver.ts"
import { printed, runs } from "../support/model.ts"
import { execute } from "../support/database.ts"
import { eventually, posted, prompted, rows, says } from "../support/owner.ts"

const plugins = [...bundled]

/** cron's job records, by name, as its key-value table holds them. */
const jobs = (running: Pick<Scenario, "data">) =>
  Object.fromEntries(
    rows(running, "SELECT id, value FROM plugin_kv_cron ORDER BY id").map(
      (row) => [
        String(row["id"]),
        JSON.parse(Buffer.from(row["value"] as Uint8Array).toString()),
      ],
    ),
  ) as Record<string, Record<string, unknown>>

/** The names of cron's timers in the core. */
const timers = (running: Pick<Scenario, "data">) =>
  rows(
    running,
    "SELECT name FROM timers WHERE plugin = 'cron' ORDER BY name",
  ).map((row) => String(row["name"]))

test("CRON-60 CRON-61 CRON-62 CRON-118 CRON-141 CRON-54 CRON-55 CRON-69 CRON-121 CRON-70 CRON-111 CRON-112 CRON-52 CRON-25 a job created with cronCreate is listed with its next run, runs in its thread's session with the wrapper and the due line, posts its answer there, and the one-shot is deleted after its run", async () => {
  const running = await scenario({ plugins })
  const { fakes } = running
  await fakes.model.script([
    runs(
      'console.log(await cronCreate({ name: "tea", prompt: "Say that it is tea time.", in: "2 seconds" })); console.log(JSON.stringify(await cronList({})))',
    ),
    { text: "Scheduled." },
    { text: "Tea time." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "remind me about tea")
  await fakes.chat.answers(thread, 1)
  const calls = await fakes.model.received(2)
  const [created, listed] = printed(calls[1])[0]!.trim().split("\n")
  expect(created).toMatch(/^Created "tea"\. Next run: /)
  expect(JSON.parse(listed!)).toEqual([
    expect.objectContaining({
      name: "tea",
      prompt: "Say that it is tea time.",
      enabled: true,
      nextRun: expect.any(String),
    }),
  ])
  expect(jobs(running)["tea"]).toMatchObject({ owner: "owner" })

  // The run is a turn of cron's in the same thread and session.
  await fakes.chat.answers(thread, 2)
  expect(await posted(running, thread)).toEqual(["Scheduled.", "Tea time."])
  const run = (await fakes.model.calls())[2]
  const body = JSON.stringify(run!.body)
  expect(prompted(run)).toContain("scheduled run")
  expect(prompted(run)).toContain("nobody is there to answer questions")
  expect(prompted(run)).toContain("Say that it is tea time.")
  expect(body).toContain('This run of \\"tea\\" was due at')
  // The owner's turn is in the history the run sends.
  expect(body).toContain("remind me about tea")
  await eventually(
    () => jobs(running),
    (all) => Object.keys(all).length === 0,
  )
  expect(timers(running)).toEqual([])
  expect(
    rows(
      running,
      "SELECT origin, origin_plugin, origin_label, outcome FROM turns ORDER BY started_at",
    ),
  ).toEqual([
    {
      origin: "message",
      origin_plugin: null,
      origin_label: null,
      outcome: "answered",
    },
    {
      origin: "plugin",
      origin_plugin: "cron",
      origin_label: "tea",
      outcome: "answered",
    },
  ])
})

test("CRON-74 FAIL-72 CRON-123 CRON-66 CRON-120 CRON-125 CRON-76 FAIL-78 CRON-130 three failed runs in a row pause a recurring job with the pause line and cancel its timer, and once resumed a run whose thread is gone pauses it at once", async () => {
  const running = await scenario({ plugins })
  const { fakes, chat } = running
  await fakes.model.script([
    runs(
      'console.log(await cronCreate({ name: "news", prompt: "Read the news.", cron: "0 9 * * *" })); for (let i = 0; i < 3; i++) console.log(await cronRun({ name: "news" }))',
    ),
    { text: "Running it." },
    { status: 400 },
    { status: 400 },
    { status: 400 },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "run the news job three times")
  expect(printed((await fakes.model.received(2))[1])[0]).toContain(
    "queued\nqueued\nqueued",
  )
  await eventually(
    () => posted(running, thread),
    (texts) =>
      texts.includes(
        "Paused `news` after 3 failed runs in a row (ModelError, InvalidRequestError). Resume it when the cause is fixed.",
      ),
  )
  expect(jobs(running)["news"]).toMatchObject({
    enabled: false,
    failures: 3,
  })
  expect(timers(running)).toEqual([])

  // Resumed, its count starts again, and a run whose thread is gone pauses it after one failure.
  await fakes.model.script([
    runs(
      'console.log(await cronUpdate({ name: "news", enabled: true })); console.log(await cronRun({ name: "news" }))',
    ),
    { text: "Resumed." },
    { text: "never posted", hold: true },
  ])
  await says(running, thread, "resume it and run it")
  await fakes.model.received(3)
  expect(jobs(running)["news"]).toMatchObject({ enabled: true, failures: 0 })
  expect(timers(running)).toEqual(["news"])
  await Effect.runPromise(
    chat.failNext(
      "post",
      new ChatError.NotFound({ detail: "thread_not_found" }),
      {
        times: 2,
      },
    ),
  )
  await fakes.model.release(2)
  await eventually(
    () => jobs(running)["news"],
    (job) => job?.["enabled"] === false,
  )
  expect(jobs(running)["news"]).toMatchObject({
    failures: 0,
    pausedBy: "ThreadGone",
  })
  expect(timers(running)).toEqual([])
})

test("CRON-77 CRON-126 CRON-147 a run that ends as UsageLimit is not a failure of the job: it keeps and pauses a one-shot, leaves a recurring job's count and timer as they were, and posts no pause line", async () => {
  const running = await scenario({
    plugins,
    env: {
      CHAD_MODEL: "openai/gpt-6-astra/medium",
      CHAD_OPENAI_API_KEY: undefined,
    },
    codex: "token",
  })
  const { fakes } = running
  const limit = {
    status: 429,
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      resets_at: 1_900_000_000,
    },
  }
  await fakes.model.script([
    runs(
      'await cronCreate({ name: "note", prompt: "Note it.", in: "1 hour" }); await cronCreate({ name: "daily", prompt: "Daily.", cron: "0 9 * * *" }); await cronRun({ name: "note" }); await cronRun({ name: "daily" })',
    ),
    { text: "Queued." },
    limit,
    limit,
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "make and run two jobs")
  await eventually(
    () =>
      rows(
        running,
        "SELECT request_key FROM turns WHERE failure = 'UsageLimit'",
      ),
    (failed) => failed.length === 2,
  )
  await eventually(
    () => jobs(running)["note"],
    (job) => job?.["enabled"] === false,
  )
  expect(jobs(running)["note"]).toMatchObject({
    failures: 0,
    pausedBy: "UsageLimit",
  })
  expect(jobs(running)["daily"]).toMatchObject({ enabled: true, failures: 0 })
  expect(jobs(running)["daily"]).not.toHaveProperty("pausedBy")
  expect(timers(running)).toEqual(["daily"])
  expect(
    (await posted(running, thread)).filter((text) => text.startsWith("Paused")),
  ).toEqual([])
})

test("CRON-78 CRON-128 CRON-131 CRON-132 the reconcile at activation cancels a timer that has no job and schedules an enabled job that has none", async () => {
  const running = await scenario({ plugins })
  const { fakes } = running
  await fakes.model.script([
    runs(
      'console.log(await cronCreate({ name: "kept", prompt: "One.", cron: "0 9 * * *" })); console.log(await cronCreate({ name: "orphan", prompt: "Two.", cron: "0 10 * * *" }))',
    ),
    { text: "Both made." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "make two jobs")
  await fakes.chat.answers(thread, 1)
  expect(timers(running)).toEqual(["kept", "orphan"])
  // A kill between the two writes of a change leaves records like these.
  execute(running.data, "DELETE FROM plugin_kv_cron WHERE id = 'orphan'")
  execute(
    running.data,
    "DELETE FROM timers WHERE plugin = 'cron' AND name = 'kept'",
  )

  expect((await running.chad(["plugin", "reload", "cron"])).code).toBe(0)
  await eventually(
    () => timers(running),
    (names) => names.join() === "kept",
  )
  expect(Object.keys(jobs(running))).toEqual(["kept"])
})
