import { Clock, DateTime, Effect, Layer } from "effect"
import type { ChatThread } from "effect/chat"
import { HttpClient } from "effect/http"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { Entry } from "../../dist/daemon/Plugins.js"
import * as Plugin from "../../dist/Plugin.js"
import * as Messages from "../../dist/Messages.js"
import asphodel from "../../dist/plugins/asphodel/index.js"
import { Turns } from "../../dist/Turns.js"
import * as Daemon from "../fixtures/asphodel/daemon.ts"
import { applied, write } from "../support/applied.ts"
import * as AdjustableClock from "../support/clock.ts"
import * as Cli from "../support/cli.ts"
import { fresh, scenario, type Scenario } from "../support/driver.ts"
import { type Call, results, runs } from "../support/model.ts"
import { eventually, rows, says, sessions } from "../support/owner.ts"

/** The plugin's settings, with the owner `local:owner` and the suite's timezone `Pacific/Auckland`. */
const settings = { url: "http://asphodel:7720", ownerName: "Tim" }

/** `chad.json` with the bundled plugin turned on with `settings`. */
const turnedOn = (options: Record<string, unknown>) =>
  JSON.stringify({
    plugins: { asphodel: { enabled: true, settings: options } },
  })

/**
 * The bundled plugin against a fake asphodel daemon. The fake and the clock are provided to the plugin's Layer as its
 * HttpClient and its Clock before `Plugin.make` brands it again, so the plugin's requests never reach the world's
 * client, and its breaker and its fiber's schedule read the time the scenario sets.
 */
const faked = () => {
  const daemon = Daemon.make()
  const clock = AdjustableClock.make()
  const plugin = Plugin.make(
    asphodel.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, daemon.client),
          Layer.succeed(Clock.Clock, clock),
        ),
      ),
    ),
  )
  return { daemon, clock, entry: { name: "asphodel", plugin } }
}

/** A daemon whose applied `chad.json` turns the plugin on with `options`, and the load's health probe and bank PUT. */
const boot = async (
  extra: ReadonlyArray<Entry> = [],
  options: Record<string, unknown> = settings,
) => {
  const directory = fresh()
  applied(join(directory, "data", "repo"), { "chad.json": turnedOn(options) })
  const { daemon, clock, entry } = faked()
  const running = await scenario({ directory, plugins: [entry, ...extra] })
  const load = await sent(daemon, 2)
  return { running, daemon, clock, load }
}

/** Waits until the fake has recorded `count` requests since the last take, and takes them. */
const sent = async (daemon: ReturnType<typeof Daemon.make>, count: number) => {
  await eventually(
    () => daemon.state.requests.length,
    (length) => length >= count,
  )
  return daemon.take()
}

/** A request as "METHOD path", with `/v1` and the bank left out. */
const route = (request: Daemon.Request) =>
  `${request.method} ${request.path.replace(/^\/v1(\/banks\/chad)?/, "")}`

/** The keys in the plugin's store, in order. */
const keys = (running: Scenario) =>
  rows(running, "SELECT id FROM plugin_kv_asphodel ORDER BY id").map((row) =>
    String(row["id"]),
  )

/** The text of every message a model call sends, system prompt included. */
const sentText = (call: Call | undefined) =>
  (
    (call?.body as { messages?: ReadonlyArray<{ content?: unknown }> })
      ?.messages ?? []
  )
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n")

/** Waits for a line the plugin logged through Effect's logger. */
const pluginLogged = (running: Scenario, message: string) =>
  running.logged(
    "plugin.log",
    (line) =>
      line.annotations["plugin"] === "asphodel" && line.message === message,
  )

const spooling =
  "asphodel: ingest failed (DaemonUnavailable); spooling the turn"

/** The session id of the only session open now. */
const openSession = (running: Scenario) =>
  String(sessions(running).find((row) => row["ended_at"] === null)?.["id"])

test("with no entry in chad.json the plugin is off and sends nothing, and an apply that turns it on with a token written ${ASPHODEL_TOKEN} loads it, the token reaching the asphodel daemon as a bearer token on every request and no log line", async () => {
  const token = "asphodel-token-5f2a9c"
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  expect(
    (
      await Cli.chad(
        ["secret", "set", "ASPHODEL_TOKEN"],
        { CHAD_DATA: data },
        token + "\n",
      )
    ).code,
  ).toBe(0)
  const { daemon, entry } = faked()
  const running = await scenario({ directory, plugins: [entry] })
  const thread = await running.fakes.chat.makeThread("direct")
  await running.fakes.model.script([{ text: "Hello." }, { text: "Booked." }])
  // Off: no tools and no hooks, so a turn sends nothing, and status says it is off.
  await says(running, thread, "hello")
  await running.fakes.chat.answers(thread, 1)
  expect(daemon.state.requests).toEqual([])
  expect((await running.chad(["status"])).stdout).toContain(
    Messages.offPlugin("asphodel", 0),
  )

  write(join(data, "repo/work"), {
    "chad.json": turnedOn({ ...settings, token: "${ASPHODEL_TOKEN}" }),
  })
  expect((await running.chad(["apply", "-m", "Turn asphodel on"])).code).toBe(0)
  const load = await sent(daemon, 2)
  await says(running, thread, "book a table for two")
  await running.fakes.chat.answers(thread, 2)
  const turn = await sent(daemon, 3)
  expect([...load, ...turn].map(route)).toEqual([
    "GET /health",
    "PUT ",
    "GET /system-prompt",
    "POST /prefetch",
    "POST /turns",
  ])
  expect([...load, ...turn].map((request) => request.authorization)).toEqual(
    Array(5).fill(`Bearer ${token}`),
  )
  expect(JSON.stringify(running.log())).not.toContain(token)
})

test("two owner turns in a direct message: one block fetch, a prefetch and an ingest each, and the second prefetch carries the first query and reply", async () => {
  const { running, daemon } = await boot()
  const { fakes } = running
  await fakes.model.script([{ text: "Booked." }, { text: "Friday works." }])
  const thread = await fakes.chat.makeThread("direct")

  const first = await says(running, thread, "book a table for two")
  await fakes.chat.answers(thread, 1)
  const one = await sent(daemon, 3)
  const session = openSession(running)
  expect(one.map(route)).toEqual([
    "GET /system-prompt",
    "POST /prefetch",
    "POST /turns",
  ])
  expect(one[0]?.query).toEqual({ session_id: session })
  expect(one[1]?.body).toEqual({
    session_id: session,
    query: "book a table for two",
  })
  expect(one[2]?.body).toEqual({
    session_id: session,
    message_at: DateTime.formatIso(first.message.timestamp),
    timezone: "Pacific/Auckland",
    user_text: "book a table for two",
    assistant_text: "Booked.",
    author: { id: "owner", name: "owner", is_bot: false },
    platform: "local",
    recall_id: "recall-1",
    forget_requested: false,
  })
  // The block is in the system prompt and the memories reach the model as the plugin's context.
  const [call] = await fakes.model.calls()
  expect(sentText(call)).toContain("[asphodel agenda, block-1]")
  expect(sentText(call)).toContain('<plugin-context plugin="asphodel">')
  expect(sentText(call)).toContain(
    '[memories for "book a table for two", recall-1]',
  )

  await says(running, thread, "and for Friday?")
  await fakes.chat.answers(thread, 2)
  const two = await sent(daemon, 2)
  expect(two.map(route)).toEqual(["POST /prefetch", "POST /turns"])
  expect(two[0]?.body).toEqual({
    session_id: session,
    query: "and for Friday?",
    previous_query: "book a table for two",
    previous_reply: "Booked.",
  })
  expect(two[1]?.body).toMatchObject({ recall_id: "recall-2" })
  // The recall ids went with their turns, and the block stays.
  expect(keys(running)).toEqual([`block/${session}`])
})

test("a turn a plugin started can recall and is refused memory_forget, memory_keep and memory_unkeep, none of which reaches the asphodel daemon, and sends no prefetch and no ingest", async () => {
  const thread = Promise.withResolvers<ChatThread.ChatThread>()
  // A plugin of the test's that starts one turn, as a cron job does.
  const cron = Plugin.make(
    Plugin.background(
      Effect.gen(function* () {
        const turns = yield* Turns
        yield* turns.start({
          thread: yield* Effect.promise(() => thread.promise),
          prompt:
            "The morning brief is due. Nobody is there to answer questions.",
          label: "morning brief",
        })
      }),
    ),
  )
  const { running, daemon } = await boot([{ name: "cron", plugin: cron }])
  const { fakes } = running
  await fakes.model.script([
    runs(`console.log(await memory_recall({ query: "dentist" }))
for (const call of [memory_forget, memory_keep, memory_unkeep])
  console.log(await call({ ids: ["m7"] }).catch((error) => "refused: " + error.message))`),
    { text: "Nothing new." },
    { text: "Noted." },
  ])
  const direct = await fakes.chat.makeThread("direct")
  thread.resolve(direct)
  await fakes.chat.answers(direct, 1)
  const calls = await fakes.model.calls()
  expect(results(calls[1]).join("\n")).toContain("m7: Tim's dentist is Dr. Lee")
  for (const tool of ["memory_forget", "memory_keep", "memory_unkeep"])
    expect(results(calls[1]).join("\n")).toContain(
      `refused: Only the owner may call ${tool}.`,
    )

  // The owner's turn after it runs behind the plugin turn's afterTurn in the plugin's queue, so its ingest is the
  // point by which the plugin turn's hooks have sent all they would. No forget, keep or unkeep is among the requests.
  await says(running, direct, "thanks")
  await fakes.chat.answers(direct, 2)
  const requests = await sent(daemon, 4)
  const session = openSession(running)
  expect(requests.map(route)).toEqual([
    "GET /system-prompt",
    "POST /recall",
    "POST /prefetch",
    "POST /turns",
  ])
  expect(requests[1]?.body).toEqual({ query: "dentist", session_id: session })
  expect(requests[3]?.body).toMatchObject({ user_text: "thanks" })
})

test("the owner's memory_forget carries the session id, the turn is ingested with forget_requested, and the next prefetch has no previous_query", async () => {
  const { running, daemon } = await boot()
  const { fakes } = running
  await fakes.model.script([
    runs('console.log(JSON.stringify(await memory_forget({ ids: ["m7"] })))'),
    { text: "Forgotten." },
    { text: "Nothing today." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "forget my dentist")
  await fakes.chat.answers(thread, 1)
  const one = await sent(daemon, 4)
  const session = openSession(running)
  expect(one.map(route)).toEqual([
    "GET /system-prompt",
    "POST /prefetch",
    "POST /forget",
    "POST /turns",
  ])
  expect(one[2]?.body).toEqual({ ids: ["m7"], session_id: session })
  expect(one[3]?.body).toMatchObject({
    user_text: "forget my dentist",
    recall_id: "recall-1",
    forget_requested: true,
  })
  const calls = await fakes.model.calls()
  expect(results(calls[1]).join("\n")).toContain(
    '{"forgotten":["m7"],"unknown":[]}',
  )

  await says(running, thread, "what's on today?")
  await fakes.chat.answers(thread, 2)
  const two = await sent(daemon, 2)
  expect(two[0]?.body).toEqual({
    session_id: session,
    query: "what's on today?",
  })
  expect(two[1]?.body).toMatchObject({ forget_requested: false })
  expect(keys(running)).toEqual([`block/${session}`])
})

test("a session that starts while the asphodel daemon is down: three refused requests open the breaker and the turn is spooled, and once it is back the next turn fetches the block and delivers the spooled turn after its own ingest, and an ingest answered with what does not decode is spooled in the same way", async () => {
  const { running, daemon, clock } = await boot()
  const { fakes } = running
  await fakes.model.script([
    { text: "Booked." },
    { text: "Rain." },
    { text: "Sun." },
    { text: "Wind." },
  ])
  const thread = await fakes.chat.makeThread("direct")

  daemon.state.up = false
  await says(running, thread, "book a table for two")
  await fakes.chat.answers(thread, 1)
  await pluginLogged(
    running,
    "asphodel: no system prompt block (DaemonUnavailable)",
  )
  await pluginLogged(running, spooling)
  // The block's two tries and the prefetch. The ingest met the open breaker and sent nothing.
  expect(daemon.state.refused).toBe(3)
  const session = openSession(running)

  // 31 seconds later the breaker has closed, and the fiber's next replay is still half a minute away.
  daemon.state.up = true
  clock.advance("31 seconds")
  await says(running, thread, "and tomorrow?")
  await fakes.chat.answers(thread, 2)
  const requests = await sent(daemon, 4)
  expect(requests.map(route)).toEqual([
    "GET /system-prompt",
    "POST /prefetch",
    "POST /turns",
    "POST /turns",
  ])
  expect(requests[0]?.query).toEqual({ session_id: session })
  expect(requests[2]?.body).toMatchObject({ user_text: "and tomorrow?" })
  expect(requests[3]?.body).toMatchObject({
    user_text: "book a table for two",
    recall_id: null,
  })
  // The block reaches the model on the session's second turn.
  expect(sentText((await fakes.model.calls()).at(-1))).toContain(
    "[asphodel agenda, block-1]",
  )

  // A 200 whose body is not an ingest answer is not the daemon refusing the turn, so the turn is kept, and the next
  // turn delivers it after its own ingest.
  daemon.state.invalid.add("POST /bank/turns")
  await says(running, thread, "and Sunday?")
  await fakes.chat.answers(thread, 3)
  await pluginLogged(
    running,
    "asphodel: ingest failed (DaemonInvalid); spooling the turn",
  )
  await eventually(
    () => keys(running),
    (found) => found.some((key) => key.startsWith("spool/")),
  )
  expect((await sent(daemon, 2)).map(route)).toEqual([
    "POST /prefetch",
    "POST /turns",
  ])
  daemon.state.invalid.clear()
  await says(running, thread, "and Monday?")
  await fakes.chat.answers(thread, 4)
  const recovered = await sent(daemon, 3)
  expect(recovered.map(route)).toEqual([
    "POST /prefetch",
    "POST /turns",
    "POST /turns",
  ])
  expect(recovered[1]?.body).toMatchObject({ user_text: "and Monday?" })
  expect(recovered[2]?.body).toMatchObject({ user_text: "and Sunday?" })
  expect(keys(running)).toEqual([`block/${session}`])
})
