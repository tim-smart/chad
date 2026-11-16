// A cron job across a kill, in layer 4: the daemon as a child process with every bundled plugin, killed and started
// again on the same volume after the job's time has passed (docs/spec/13-timers-and-cron.md, "Overdue runs, kills and
// restarts").
import { expect, test } from "vitest"
import { runs } from "../support/model.ts"
import { eventually, posted, rows, says } from "../support/owner.ts"
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
