// A cron job across a kill, in layer 4: the daemon as a child process with every bundled plugin, killed and started
// again on the same volume after the job's time has passed (docs/spec/13-timers-and-cron.md, "Overdue runs, kills and
// restarts").
import { join } from "node:path"
import { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { applied } from "../support/applied.ts"
import { runs } from "../support/model.ts"
import { eventually, posted, prompted, rows, says } from "../support/owner.ts"
import { daemon } from "../support/process.ts"

test("CRON-26 CRON-31 CRON-52 CRON-57 a one-shot job survives a kill and fires once when chad starts again after its time, and is deleted after that run", async () => {
  const running = await daemon({ bundled: true })
  const { fakes } = running
  await fakes.model.script([
    runs(
      'console.log(await cronCreate({ name: "later", prompt: "Say that it is later.", in: "2 seconds" }))',
    ),
    { text: "Set." },
    { text: "It is later." },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "remind me later")
  await fakes.chat.answers(thread, 1)
  const [job] = rows(running, "SELECT value FROM plugin_kv_cron")
  const at = Number(
    JSON.parse(Buffer.from(job!["value"] as Uint8Array).toString())["at"],
  )
  expect((await first.kill()).signal).toBe("SIGKILL")

  // chad is down when the job comes due.
  await eventually(
    () => Date.now(),
    (now) => now > at,
  )
  await running.start()
  await fakes.chat.answers(thread, 2)
  expect(await posted(running, thread)).toEqual(["Set.", "It is later."])
  await eventually(
    () => rows(running, "SELECT id FROM plugin_kv_cron"),
    (left) => left.length === 0,
  )
  expect(
    rows(running, "SELECT origin_label FROM turns WHERE origin = 'plugin'"),
  ).toEqual([{ origin_label: "later" }])
  expect(await fakes.model.calls()).toHaveLength(3)
}, 20_000)

/** A plugin of the owner's repo with one timer that runs every second in a thread, scheduled once. */
const chain = (
  thread: ChatThread.ChatThread,
) => `import { Effect, Option } from "effect"
import { ChatThread } from "effect/chat"
import { Plugin, Turns } from "chad"

export default Plugin.make(
  Plugin.background(
    Effect.gen(function* () {
      const turns = yield* Turns.Turns
      if ((yield* turns.scheduled()).length > 0) return
      yield* turns.schedule({
        name: "tick",
        cron: "* * * * * *",
        timezone: "UTC",
        thread: Option.getOrThrow(ChatThread.fromString(${JSON.stringify(ChatThread.toString(thread))})),
        prompt: "tick",
        label: "tick",
      })
    }),
  ),
)
`

test("CRON-27 CRON-28 CRON-29 a recurring timer killed in the middle of its turn resumes that scheduled run as the same turn after the restart, and the chain then goes on with one turn per later time", async () => {
  const running = await daemon()
  const { fakes } = running
  const thread = await fakes.chat.makeThread("direct")
  applied(join(running.data, "repo"), { "plugins/chain.ts": chain(thread) })
  await fakes.model.script([
    { text: "never sent", hold: true },
    ...Array.from({ length: 20 }, () => ({ text: "tick" })),
  ])
  const ticks = () =>
    rows(
      running,
      "SELECT request_key, turn_id, starts, outcome FROM turns WHERE request_key LIKE 'timer/chain/tick/%' ORDER BY started_at",
    )
  const first = await running.start()
  await fakes.model.received(1)
  const [cut] = ticks()
  expect(cut).toMatchObject({ starts: 1, outcome: null })
  expect((await first.kill()).signal).toBe("SIGKILL")

  const second = await running.start()
  await eventually(
    () => ticks().filter((row) => row["outcome"] === "answered"),
    (answered) => answered.length >= 3,
  )
  await second.stop()
  const calls = await fakes.model.calls()
  // The first call after the restart resumes the cut turn (CRON-28).
  expect(prompted(calls[1])).toBe(Messages.restartNote())
  const all = ticks()
  expect(all[0]).toEqual({ ...cut, starts: 2, outcome: "answered" })
  // Each later scheduled time is one turn, after the resumed one (CRON-27, CRON-29).
  const times = all.map((row) =>
    Number(String(row["request_key"]).split("/").pop()),
  )
  expect(new Set(times).size).toBe(times.length)
  expect([...times].sort((x, y) => x - y)).toEqual(times)
  expect(new Set(all.map((row) => row["turn_id"])).size).toBe(all.length)
  expect(await posted(running, thread)).not.toContain("never sent")
}, 30_000)
