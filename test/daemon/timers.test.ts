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
import { scenario, type Scenario } from "../support/driver.ts"
import { eventually, rows } from "../support/owner.ts"

/** A bundled plugin that hands over its `Turns` and records the origin of every turn it sees start. */
const probe = () => {
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
  return { seen, plugins: [{ name: "probe", plugin }] }
}

const call = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

/** The scheduled times of the timer's turns, in the order they started. */
const runs = (running: Pick<Scenario, "data">, name: string) =>
  rows(
    running,
    `SELECT request_key FROM turns WHERE request_key LIKE 'timer/probe/${name}/%' ORDER BY started_at`,
  ).map((row) => Number(String(row["request_key"]).split("/").pop()))

/** The wake-ups stored for a timer that are not processed. */
const pending = (running: Pick<Scenario, "data">, name: string) =>
  rows(
    running,
    `SELECT 1 FROM cluster_messages WHERE entity_type = 'Timer' AND entity_id = 'probe/${name}' AND processed = 0`,
  ).length

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const everySecond = (thread: ChatThread.ChatThread) => ({
  name: "tick",
  cron: "* * * * * *",
  timezone: "Pacific/Auckland",
  thread,
  prompt: "tick",
  label: "tick",
})

test("CRON-6 CRON-7 CRON-9 CRON-15 CRON-16 CRON-19 CRON-20 CRON-25 API-121 API-122 a one-shot fires once in its thread with the timer on the turn's origin and is gone after its turn, a replace fires only the new time, a recurring chain runs one turn per scheduled time, and a cancel stops it", async () => {
  const { seen, plugins } = probe()
  const running = await scenario({ plugins })
  const { fakes } = running
  await running.logged("boot.ready")
  await fakes.model.script(Array.from({ length: 20 }, () => ({ text: "ok" })))
  const thread = await fakes.chat.makeThread("direct")
  const turns = seen.turns!

  // Scheduled for a minute away and replaced with a time half a second away: only the new time fires.
  const later = DateTime.makeUnsafe(Date.now() + 60_000)
  await call(
    turns.schedule({
      name: "once",
      at: later,
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
  expect(seen.origins).toMatchObject([
    { _tag: "Plugin", plugin: "probe", label: "once", timer: { name: "once" } },
  ])
  expect(
    DateTime.toEpochMillis(
      (seen.origins[0] as { timer: { scheduledAt: DateTime.Utc } }).timer
        .scheduledAt,
    ),
  ).toBe(soon)
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
  await fakes.chat.answers(thread, 4)
  const chain = runs(running, "tick")
  expect(chain.length).toBeGreaterThanOrEqual(3)
  expect(new Set(chain).size).toBe(chain.length)
  for (const at of chain) expect(at % 1000).toBe(0)

  await call(turns.cancel("tick"))
  const stopped = runs(running, "tick").length
  await sleep(2500)
  // A run that had started when the cancel landed finishes, and nothing fires after it.
  expect(runs(running, "tick").length).toBeLessThanOrEqual(stopped + 1)
  expect(rows(running, "SELECT * FROM timers")).toEqual([])
  expect(pending(running, "tick")).toBe(0)
  expect(await call(turns.scheduled())).toEqual([])
}, 30_000)

test("CRON-26 CRON-27 SES-16 a recurring timer whose runs were missed while chad was stopped fires once at the next start, as one overdue scheduled time, and its chain goes on", async () => {
  const first = probe()
  const before = await scenario({ plugins: first.plugins })
  await before.logged("boot.ready")
  await before.fakes.model.script(
    Array.from({ length: 5 }, () => ({ text: "ok" })),
  )
  const thread = await before.fakes.chat.makeThread("direct")
  await call(first.seen.turns!.schedule(everySecond(thread)))
  await before.fakes.chat.answers(thread, 1)
  expect(await before.stop()).toBe(0)
  const earlier = runs(before, "tick")
  await sleep(3000)

  const second = probe()
  const running = await scenario({
    directory: before.directory,
    plugins: second.plugins,
  })
  await running.fakes.model.script(
    Array.from({ length: 10 }, () => ({ text: "ok" })),
  )
  const again = await running.fakes.chat.makeThread("direct")
  expect(again).toEqual(thread)
  await running.fakes.chat.answers(again, 2)
  const up = Date.parse(
    running
      .log()
      .filter((line) => line.annotations["event"] === "boot.started")
      .at(-1)!.timestamp,
  )
  const after = runs(running, "tick").filter((at) => !earlier.includes(at))
  // Three scheduled times passed while chad was down. One of them fires, and the next is after the restart.
  const overdue = after.filter((at) => at < up)
  expect(overdue).toHaveLength(1)
  expect(after.length).toBeGreaterThanOrEqual(2)
  expect(new Set(after).size).toBe(after.length)
}, 30_000)

test("CRON-30 CRON-32 CRON-35 CRON-36 CRON-37 SET-41 SET-42 SET-43 SET-84 FAIL-113 CLI-71 CLI-126 a timer of a plugin that is off is held, shows on the plugin's off line and not under Problems, fires once when the plugin is back on as the apply says, and goes with chad plugin purge", async () => {
  const { seen, plugins } = probe()
  const running = await scenario({ plugins })
  const { fakes } = running
  await running.logged("boot.ready")
  await fakes.model.script(Array.from({ length: 20 }, () => ({ text: "ok" })))
  const thread = await fakes.chat.makeThread("direct")
  const work = join(running.data, "repo/work")
  const apply = async (message: string) => {
    const ran = await running.chad(["apply", "-m", message])
    expect(ran.code).toBe(0)
    return ran.stdout
  }

  write(work, {
    "chad.json": JSON.stringify({ plugins: { probe: { enabled: false } } }),
  })
  await apply("Turn probe off")
  await call(seen.turns!.schedule(everySecond(thread)))
  await running.logged("timer.held")
  await sleep(1500)
  expect(runs(running, "tick")).toEqual([])
  const status = await running.chad(["status"])
  expect(status.stdout).toContain(Messages.offPlugin("probe", 1))
  expect(status.stdout).not.toContain(Messages.timersHeldProblem("probe", 1))

  const on = Date.now()
  write(work, { "chad.json": JSON.stringify({ plugins: {} }) })
  expect(await apply("Turn probe on")).toContain(
    Messages.timersWillFire("probe", 1),
  )
  await fakes.chat.answers(thread, 2)
  const fired = runs(running, "tick")
  expect(fired.filter((at) => at < on)).toHaveLength(1)
  expect(new Set(fired).size).toBe(fired.length)

  // Off again, the timer is kept, and a purge of the plugin that is off deletes it.
  write(work, {
    "chad.json": JSON.stringify({ plugins: { probe: { enabled: false } } }),
  })
  await apply("Turn probe off again")
  const purged = await running.chad(["plugin", "purge", "probe"])
  expect(purged.code).toBe(0)
  expect(purged.stdout).toContain("1 timer")
  expect(rows(running, "SELECT * FROM timers")).toEqual([])
  expect(pending(running, "tick")).toBe(0)
}, 40_000)
