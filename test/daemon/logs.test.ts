import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { scenario } from "../support/driver.ts"
import { says } from "../support/owner.ts"

test("chad logs filters the daemon's log by turn and event prefix, prints the stored lines with --json, exits 0 when nothing matches and 2 for a level or time it cannot read, and reads the log with no daemon", async () => {
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
