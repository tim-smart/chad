// The timers in chad's core, as a plugin reaches them through `Turns` and the owner sees them in `chad status` and
// `chad apply` (docs/spec/13-timers-and-cron.md).
import { join } from "node:path"
import { DateTime, Effect, Layer } from "effect"
import type { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import type * as Session from "../../dist/Session.js"
import { Turns } from "../../dist/Turns.js"
import { write } from "../support/applied.ts"
import { execute } from "../support/database.ts"
import { scenario, type Scenario } from "../support/driver.ts"
import { eventually, rows } from "../support/owner.ts"

/** A plugin handed to the daemon that gives the test its `Turns` and records the origin of every turn it sees start. */
const probe = (name = "probe") => {
  const seen: { turns?: Turns["Service"]; origins: Array<Session.Origin> } = {
    origins: [],
  }
  const plugin = Plugin.make(
    Layer.mergeAll(
      Layer.effectDiscard(
        Effect.gen(function* () {
          seen.turns = yield* Turns
        }),
      ),
      Plugin.beforeTurn((turn) =>
        Effect.sync(() => {
          seen.origins.push(turn.origin)
          return ""
        }),
      ),
    ),
  )
  return { seen, entry: { name, plugin } }
}

const call = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

/** The scheduled times of a timer's turns, in the order they started. */
const runs = (running: Pick<Scenario, "data">, name: string) =>
  rows(
    running,
    `SELECT request_key FROM turns WHERE request_key LIKE 'timer/%/${name}/%' ORDER BY started_at`,
  ).map((row) => Number(String(row["request_key"]).split("/").pop()))

/**
 * Waits until `ms` have passed, by a one-shot timer of the plugin `clock` and the answer of its turn, so the wait is on
 * an event of chad's own.
 */
const passes = async (
  running: Scenario,
  clock: Turns["Service"],
  thread: ChatThread.ChatThread,
  ms: number,
) => {
  const name = `clock-${Date.now()}`
  await call(
    clock.schedule({
      name,
      at: DateTime.makeUnsafe(Date.now() + ms),
      thread,
      prompt: "clock",
      label: "clock",
    }),
  )
  // The one-shot's row goes once its turn has ended (CRON-25).
  await eventually(
    () => [
      runs(running, name).length,
      rows(
        running,
        `SELECT 1 FROM timers WHERE plugin = 'clock' AND name = '${name}'`,
      ).length,
    ],
    ([fired, left]) => fired === 1 && left === 0,
  )
}

/** The wake-ups stored for a timer that are not processed. */
const pending = (running: Pick<Scenario, "data">, name: string) =>
  rows(
    running,
    `SELECT 1 FROM cluster_messages WHERE entity_type = 'Timer' AND entity_id = 'probe/${name}' AND processed = 0`,
  ).length

const everySecond = (thread: ChatThread.ChatThread) => ({
  name: "tick",
  cron: "* * * * * *",
  timezone: "Pacific/Auckland",
  thread,
  prompt: "tick",
  label: "tick",
})

test("CRON-6 CRON-7 CRON-9 API-133 CRON-15 CRON-16 CRON-19 CRON-20 CRON-23 CRON-25 API-87 API-90 API-121 API-122 a one-shot fires once in its thread with the timer on the turn's origin and is gone after its turn, a replace fires only the new time, a recurring chain runs one turn per scheduled time, a cancel stops it, and a replace that cannot be saved keeps the earlier timer", async () => {
  const probed = probe()
  const clock = probe("clock")
  const running = await scenario({ plugins: [probed.entry, clock.entry] })
  const { fakes } = running
  await running.logged("boot.ready")
  await fakes.model.script(Array.from({ length: 20 }, () => ({ text: "ok" })))
  const thread = await fakes.chat.makeThread("direct")
  const turns = probed.seen.turns!

  // Scheduled for a minute away and replaced with a time half a second away: only the new time fires.
  await call(
    turns.schedule({
      name: "once",
      at: DateTime.makeUnsafe(Date.now() + 60_000),
      thread,
      prompt: "p1",
      label: "once",
    }),
  )
  const soon = Date.now() + 500
  await call(
    turns.schedule({
      name: "once",
      at: DateTime.makeUnsafe(soon),
      thread,
      prompt: "p2",
      label: "once",
    }),
  )
  expect(pending(running, "once")).toBe(1)
  await fakes.chat.answers(thread, 1)
  await eventually(
    () => rows(running, "SELECT * FROM timers"),
    (left) => left.length === 0,
  )
  expect(runs(running, "once")).toEqual([soon])
  expect(probed.seen.origins).toMatchObject([
    { _tag: "Plugin", plugin: "probe", label: "once", timer: { name: "once" } },
  ])
  const [origin] = probed.seen.origins as Array<{
    readonly timer: { readonly scheduledAt: DateTime.Utc }
  }>
  expect(DateTime.toEpochMillis(origin!.timer.scheduledAt)).toBe(soon)
  expect(await call(turns.scheduled())).toEqual([])
  expect(pending(running, "once")).toBe(0)

  // A recurring timer: each scheduled time is one turn, and the next run is saved after the turn ends.
  await call(turns.schedule(everySecond(thread)))
  const [listed] = await call(turns.scheduled())
  expect(listed).toMatchObject({
    name: "tick",
    schedule: { cron: "* * * * * *", timezone: "Pacific/Auckland" },
    label: "tick",
  })
  expect(await call(clock.seen.turns!.scheduled())).toEqual([])
  await fakes.chat.answers(thread, 4)
  const chain = runs(running, "tick")
  expect(chain.length).toBeGreaterThanOrEqual(3)
  expect(new Set(chain).size).toBe(chain.length)
  for (const at of chain) expect(at % 1000).toBe(0)

  await call(turns.cancel("tick"))
  const stopped = runs(running, "tick").length
  await passes(running, clock.seen.turns!, thread, 2500)
  // A run that had started when the cancel landed finishes, and nothing fires after it.
  expect(runs(running, "tick").length).toBeLessThanOrEqual(stopped + 1)
  expect(rows(running, "SELECT * FROM timers")).toEqual([])
  expect(pending(running, "tick")).toBe(0)
  expect(await call(turns.scheduled())).toEqual([])

  // A full disk while a replace is saved: the call fails and the earlier timer, row and wake-up, is as it was.
  const later = {
    name: "later",
    at: DateTime.makeUnsafe(Date.now() + 60_000),
    thread,
    prompt: "kept",
    label: "later",
  }
  await call(turns.schedule(later))
  execute(
    running.data,
    "CREATE TRIGGER full BEFORE INSERT ON cluster_messages WHEN NEW.entity_type = 'Timer' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
  )
  await expect(
    call(
      turns.schedule({
        ...later,
        at: DateTime.makeUnsafe(Date.now() + 120_000),
        prompt: "replaced",
      }),
    ),
  ).rejects.toThrow("Nothing was changed")
  execute(running.data, "DROP TRIGGER full")
  expect(await call(turns.scheduled())).toMatchObject([
    { name: "later", prompt: "kept", nextRun: later.at },
  ])
  expect(pending(running, "later")).toBe(1)
}, 30_000)

test("CRON-26 CRON-27 CRON-30 CRON-31 CRON-32 CRON-35 CRON-36 CRON-37 SES-16 SES-113 SET-41 SET-42 SET-43 SET-84 FAIL-113 CLI-71 CLI-126 a timer of a plugin that is off is held across a restart, shows on the plugin's off line and not under Problems, fires once for all its missed runs when the plugin is back on, as the apply says, and goes with chad plugin purge", async () => {
  const first = probe()
  const before = await scenario({
    plugins: [first.entry, probe("clock").entry],
  })
  await before.logged("boot.ready")
  await before.fakes.model.script(
    Array.from({ length: 5 }, () => ({ text: "ok" })),
  )
  const thread = await before.fakes.chat.makeThread("direct")
  const apply = async (running: Scenario, message: string) => {
    const ran = await running.chad(["apply", "-m", message])
    expect(ran.code).toBe(0)
    return ran.stdout
  }
  const turnOff = (running: Scenario) => {
    write(join(running.data, "repo/work"), {
      "chad.json": JSON.stringify({ plugins: { probe: { enabled: false } } }),
    })
    return apply(running, "Turn probe off")
  }
  await call(first.seen.turns!.schedule(everySecond(thread)))
  await before.fakes.chat.answers(thread, 1)
  await turnOff(before)
  await before.logged("timer.held")
  const status = await before.chad(["status"])
  expect(status.stdout).toContain(Messages.offPlugin("probe", 1))
  expect(status.stdout).not.toContain(Messages.timersHeldProblem("probe", 1))
  expect(await before.stop()).toBe(0)
  const earlier = runs(before, "tick")

  // The held request is delivered again after the restart and held again, while two seconds of runs are missed.
  const clock = probe("clock")
  const running = await scenario({
    directory: before.directory,
    plugins: [probe().entry, clock.entry],
  })
  const { fakes } = running
  await fakes.model.script(Array.from({ length: 10 }, () => ({ text: "ok" })))
  expect(await fakes.chat.makeThread("direct")).toEqual(thread)
  // The log holds both daemons' lines, so the second hold is the second timer.held line.
  await eventually(
    () =>
      running
        .log()
        .filter((line) => line.annotations["event"] === "timer.held"),
    (held) => held.length === 2,
  )
  await eventually(
    () => clock.seen.turns,
    (turns) => turns !== undefined,
  )
  await passes(running, clock.seen.turns!, thread, 2500)
  expect(runs(running, "tick")).toEqual(earlier)

  write(join(running.data, "repo/work"), {
    "chad.json": JSON.stringify({ plugins: {} }),
  })
  const on = Date.now()
  expect(await apply(running, "Turn probe on")).toContain(
    Messages.timersWillFire("probe", 1),
  )
  await eventually(
    () => runs(running, "tick").filter((at) => !earlier.includes(at)),
    (fired) => fired.length >= 2,
  )
  const fired = runs(running, "tick").filter((at) => !earlier.includes(at))
  expect(fired.filter((at) => at < on)).toHaveLength(1)
  expect(new Set(fired).size).toBe(fired.length)

  // Off again, the timer is kept, and a purge of the plugin that is off deletes it.
  await turnOff(running)
  const purged = await running.chad(["plugin", "purge", "probe"])
  expect(purged.code).toBe(0)
  expect(purged.stdout).toContain(Messages.purged("probe", 0, 1))
  expect(rows(running, "SELECT * FROM timers")).toEqual([])
  expect(pending(running, "tick")).toBe(0)
}, 40_000)
