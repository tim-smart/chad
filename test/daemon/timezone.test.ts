// The owner's timezone as the owner, a plugin and the agent reach it: `chad timezone` with and without the daemon, the
// zone a plugin reads as `DateTime.CurrentTimeZone` and a session's processes get as `TZ`, and the reload a change makes.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import { scenario, type Scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { eventually, posted, says, sessions } from "../support/owner.ts"

const zoneTools = Toolkit.make(
  Tool.make("zone", {
    description: "Says the zone the plugin was built with.",
    parameters: Schema.Struct({}),
    success: Schema.String,
  }),
)

/** A plugin whose tool gives the zone it read when its Layer was built. */
const clock = Plugin.make(
  Plugin.toolkit(zoneTools).pipe(
    Layer.provide(
      zoneTools.toLayer(
        Effect.gen(function* () {
          const zone = DateTime.zoneToString(yield* DateTime.CurrentTimeZone)
          return zoneTools.of({ zone: () => Effect.succeed(zone) })
        }),
      ),
    ),
  ),
)

/** A plugin that cannot be built in Tokyo. */
const picky = Plugin.make(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const zone = DateTime.zoneToString(yield* DateTime.CurrentTimeZone)
      if (zone === "Asia/Tokyo")
        return yield* Effect.die(new Error(`unknown time zone ${zone}`))
    }),
  ),
)

/** One owner turn whose script prints the plugin's zone and the `TZ` a process of the session sees. */
const ask = async (running: Scenario, thread: Parameters<typeof says>[1]) => {
  const ended = running
    .log()
    .filter((line) => line.annotations["event"] === "turn.ended").length
  await running.fakes.model.script([
    runs('console.log(await zone({}), (await run("printenv TZ")).trim())'),
    { text: "done" },
  ])
  await says(running, thread, "what time is it")
  await eventually(
    () =>
      running.log().filter((line) => line.annotations["event"] === "turn.ended")
        .length,
    (count) => count > ended,
  )
  return results((await running.fakes.model.calls())[1]).at(-1) ?? ""
}

test("a timezone the agent sets is stored, reaches the plugins and the session's processes, and posts a line in the session; a plugin that cannot rebuild keeps its old version, the command exits 1 and status marks it; a zone that is no named zone exits 2 and changes nothing", async () => {
  const running = await scenario({
    plugins: [
      { name: "clock", plugin: clock },
      { name: "picky", plugin: picky },
    ],
  })
  const file = join(running.data, "state/timezone")
  const thread = await running.fakes.chat.makeThread("direct")

  // With nothing stored the suite's TZ is the owner's zone.
  expect(await ask(running, thread)).toContain(
    "Pacific/Auckland Pacific/Auckland",
  )
  expect((await running.chad(["timezone"])).stdout).toBe(
    Messages.timezoneInForce("Pacific/Auckland", "variable", undefined) + "\n",
  )

  // The agent sets it from its session, by a name Intl resolves.
  const session = String(sessions(running)[0]?.["id"])
  expect(
    await running.chad(["timezone", "europe/berlin"], {
      CHAD_SESSION: session,
    }),
  ).toMatchObject({
    code: 0,
    stdout: Messages.timezoneSet("Europe/Berlin") + "\n",
  })
  expect(readFileSync(file, "utf8")).toBe("Europe/Berlin\n")
  await eventually(
    () => posted(running, thread),
    (lines) =>
      lines.includes(`-# ${Messages.timezoneLine("Europe/Berlin", [])}`),
  )
  expect(await ask(running, thread)).toContain("Europe/Berlin Europe/Berlin")
  expect((await running.chad(["timezone"])).stdout).toBe(
    Messages.timezoneInForce("Europe/Berlin", "stored", undefined) + "\n",
  )

  // An offset and an unknown name exit 2 and leave the stored zone.
  for (const zone of ["+05:00", "Mars/Olympus"]) {
    expect(await running.chad(["timezone", zone])).toMatchObject({
      code: 2,
      stderr: Messages.timezoneInvalid(zone) + "\n",
    })
  }
  expect(readFileSync(file, "utf8")).toBe("Europe/Berlin\n")

  // A plugin that fails to rebuild keeps its old version, the change stays stored and the command exits 1 naming it.
  const tokyo = await running.chad(["timezone", "Asia/Tokyo"])
  expect(tokyo.code).toBe(1)
  expect(tokyo.stdout).toBe(Messages.timezoneSet("Asia/Tokyo") + "\n")
  expect(tokyo.stderr).toContain("picky: ")
  expect(tokyo.stderr).toContain("unknown time zone Asia/Tokyo")
  expect(readFileSync(file, "utf8")).toBe("Asia/Tokyo\n")
  const mark = Messages.runningPrevious("timezone", "").split(":")[0]
  const status = (await running.chad(["status"])).stdout
  expect(status).toContain(`plugin: picky, ${mark}: `)
  expect(status).not.toContain(`plugin: clock, ${mark}`)
  expect(await ask(running, thread)).toContain("Asia/Tokyo Asia/Tokyo")
}, 30_000)
