// The bundled cron plugin as the model reaches it through its five tools, and as its jobs run, fail and are reconciled
// with the core's timers (docs/spec/13-timers-and-cron.md).
import { Effect } from "effect"
import { ChatError, ChatThread } from "effect/chat"
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

/** The jobs that have a timer in the core, by the label of its turns, which is the job's name. */
const timers = (running: Pick<Scenario, "data">) =>
  rows(
    running,
    "SELECT label FROM timers WHERE plugin = 'cron' ORDER BY label",
  ).map((row) => String(row["label"]))

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

test("CRON-72 CRON-64 CRON-67 CRON-148 CRON-149 a job's runs go one at a time across threads: a run asked for after the job moved waits for the run in progress and then runs in the new thread, a cronRun needs no write to the job's store, a one-shot moved on during a manual run keeps its new time, and runs of a removed job, in progress or queued, leave a new job of its name alone", async () => {
  const running = await scenario({ plugins })
  const { fakes } = running
  const a = await fakes.chat.makeThread("direct")
  const b = await fakes.chat.makeThread("direct")
  expect(b).not.toEqual(a)
  const timerThread = (name: string) =>
    rows(
      running,
      `SELECT thread FROM timers WHERE plugin = 'cron' AND label = '${name}'`,
    ).map((row) => String(row["thread"]))
  /** The start and end of each run of a job, in the order they started. */
  const runsOf = (name: string) =>
    rows(
      running,
      `SELECT started_at, ended_at FROM turns WHERE origin_plugin = 'cron' AND origin_label = '${name}' ORDER BY started_at`,
    ).map((row) => ({
      started: Number(row["started_at"]),
      ended: Number(row["ended_at"]),
    }))
  /**
   * Waits until cron's `afterTurn` hooks queued so far have run. They run one at a time in order, so a one-shot made
   * and run now is deleted after them.
   */
  const settled = async (thread: ChatThread.ChatThread, name: string) => {
    await fakes.model.script([
      runs(
        `await cronCreate({ name: "${name}", prompt: "Ping.", in: "1 hour" }); await cronRun({ name: "${name}" })`,
      ),
      { text: "Ok." },
      { text: "pong" },
    ])
    await says(running, thread, "ping")
    await eventually(
      () => [runsOf(name), jobs(running)[name]] as const,
      ([ran, job]) =>
        ran.length === 1 && ran[0]!.ended > 0 && job === undefined,
    )
  }

  // A run held in thread A. From B the job is run again while its store cannot be written, then moved to B and run
  // a third time. The runs go one after another, each in the thread the job had when it was asked for.
  await fakes.model.script([
    runs(
      'await cronCreate({ name: "daily", prompt: "Daily.", cron: "0 9 * * *" }); console.log(await cronRun({ name: "daily" }))',
    ),
    { text: "Queued." },
    { text: "daily one", hold: true },
    runs('console.log(await cronRun({ name: "daily" }))'),
    { text: "Asked." },
    runs(
      'await cronUpdate({ name: "daily" }); console.log(await cronRun({ name: "daily" }))',
    ),
    { text: "Moved." },
    { text: "daily two" },
    { text: "daily three" },
  ])
  await says(running, a, "make daily and run it")
  await fakes.model.received(3)
  execute(
    running.data,
    "CREATE TRIGGER full BEFORE INSERT ON plugin_kv_cron BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
  )
  await says(running, b, "run daily")
  await fakes.chat.answers(b, 1)
  execute(running.data, "DROP TRIGGER full")
  await says(running, b, "move daily here and run it")
  await fakes.chat.answers(b, 2)
  const asked = await fakes.model.received(7)
  expect(printed(asked[4])).toEqual(["queued\n"])
  expect(jobs(running)["daily"]).toMatchObject({
    thread: ChatThread.toString(b),
  })
  expect(timerThread("daily")).toEqual([ChatThread.toString(b)])
  await fakes.model.release(2)
  const ran = await eventually(
    () => runsOf("daily"),
    (all) => all.length === 3 && all.every((run) => run.ended > 0),
  )
  expect(ran[1]!.started).toBeGreaterThanOrEqual(ran[0]!.ended)
  expect(ran[2]!.started).toBeGreaterThanOrEqual(ran[1]!.ended)
  await fakes.chat.answers(a, 3)
  await fakes.chat.answers(b, 3)
  expect(await posted(running, a)).toEqual([
    "Queued.",
    "daily one",
    "daily two",
  ])
  expect(await posted(running, b)).toEqual(["Asked.", "Moved.", "daily three"])

  // A one-shot run by hand and moved on an hour from B while the run is held: the run's end keeps the new time.
  await fakes.model.script([
    runs(
      'await cronCreate({ name: "note", prompt: "Note it.", in: "1 hour" }); console.log(await cronRun({ name: "note" }))',
    ),
    { text: "Queued." },
    { text: "note one", hold: true },
    runs('console.log(await cronUpdate({ name: "note", in: "2 hours" }))'),
    { text: "Moved on." },
  ])
  await says(running, a, "make note and run it")
  await fakes.model.received(3)
  const due = jobs(running)["note"]!["at"] as number
  await says(running, b, "move note on an hour")
  await fakes.chat.answers(b, 4)
  await fakes.model.release(2)
  await settled(a, "ping1")
  expect(jobs(running)["note"]!["at"]).toBeGreaterThan(due)
  expect(jobs(running)["note"]).not.toHaveProperty("started")
  expect(timerThread("note")).toEqual([ChatThread.toString(b)])

  // Two runs of daily asked for in B, the first held and the second queued behind it. From A daily is removed and
  // made again as a one-shot. Both old runs fail, and the new job is left as it was made.
  await fakes.model.script([
    runs(
      'console.log(await cronRun({ name: "daily" })); console.log(await cronRun({ name: "daily" }))',
    ),
    { text: "Running." },
    { status: 400, hold: true },
    runs(
      'await cronRemove({ name: "daily" }); console.log(await cronCreate({ name: "daily", prompt: "Other.", in: "1 hour" }))',
    ),
    { text: "Replaced." },
    { status: 400 },
  ])
  await says(running, b, "run daily twice")
  await fakes.model.received(3)
  await says(running, a, "replace daily")
  await fakes.chat.answers(a, 8)
  const made = jobs(running)["daily"]!
  await fakes.model.release(2)
  await eventually(
    () =>
      rows(
        running,
        "SELECT 1 FROM turns WHERE origin_label = 'daily' AND outcome = 'failed'",
      ),
    (failed) => failed.length === 2,
  )
  await settled(a, "ping2")
  expect(jobs(running)["daily"]).toEqual(made)
  expect(made).toMatchObject({
    enabled: true,
    failures: 0,
    thread: ChatThread.toString(a),
    at: expect.any(Number),
  })
  expect(made["prompt"]).toContain("Other.")
  expect(timerThread("daily")).toEqual([ChatThread.toString(a)])
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
    "DELETE FROM timers WHERE plugin = 'cron' AND label = 'kept'",
  )

  expect((await running.chad(["plugin", "reload", "cron"])).code).toBe(0)
  await eventually(
    () => timers(running),
    (names) => names.join() === "kept",
  )
  expect(Object.keys(jobs(running))).toEqual(["kept"])
})
