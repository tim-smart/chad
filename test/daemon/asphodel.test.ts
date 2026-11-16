// The asphodel fixture through the real daemon. The fixture is handed to `runDaemon` through the plugins input, with
// the fake asphodel daemon provided as its HttpClient and an adjustable clock as its Clock, so a scenario moves past the
// breaker's 30 seconds and the replay's minute instead of waiting them out.
//
// Each of the fixture's twelve scenarios and the test that covers it, or why none does:
//   1  the plugin loads                        "the plugin loads", and the token and timezone tests after it
//   2  two owner turns in a direct message     "two owner turns in a direct message"
//   3  a message steers the turn               "a message that steers the turn"
//   4  a cron turn                             "a turn a plugin started"
//   5  the owner asks to forget                "the owner's memory_forget"
//   6  a tool call after its turn ended        none: the daemon makes no tool call with no turn, and the
//                                              type layer holds the fixture's None branch (test/types/plugins.test.ts)
//   7  the daemon down for a turn              "with the asphodel daemon down a turn runs without memories"
//   7b the spool replayed by the fiber         "when the owner says nothing more after an outage"
//   8  a compaction                            "after a compaction"; the variant with no wait has no counterpart
//   9  /new                                    "/new clears the old session"
//   10 a restart in the middle of a turn       the process test, test/process/asphodel.test.ts
//   11 a session starts while the daemon is down  "a session that starts while the asphodel daemon is down"
//   12 the plugin unloads                      "the plugin unloads at the stop"
import { Clock, DateTime, Effect, Layer } from "effect"
import type { ChatThread } from "effect/chat"
import { HttpClient } from "effect/http"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { Entry } from "../../dist/daemon/Plugins.js"
import * as Plugin from "../../dist/Plugin.js"
import { Turns } from "../../dist/Turns.js"
import asphodel from "../fixtures/asphodel/asphodel.ts"
import * as Daemon from "../fixtures/asphodel/daemon.ts"
import * as AdjustableClock from "../support/clock.ts"
import * as Cli from "../support/cli.ts"
import { fresh, scenario, type Scenario } from "../support/driver.ts"
import { type Call, results, runs } from "../support/model.ts"
import { eventually, posted, rows, says, sessions } from "../support/owner.ts"

/** The prototype's settings, with the owner `local:owner` and the suite's timezone `Pacific/Auckland`. */
const settings = { url: "http://asphodel:7720", ownerName: "Tim" }

/**
 * A daemon with the fixture loaded against a fresh fake asphodel daemon. The fake and the clock are provided to the
 * fixture's Layer as its HttpClient and its Clock before `Plugin.make` brands it again, so the plugin's requests never
 * reach the world's client, and its breaker and its fiber's schedule read the time the scenario sets.
 */
const boot = async (
  extra: ReadonlyArray<Entry> = [],
  options: Record<string, unknown> = settings,
  directory?: string,
) => {
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
  const running = await scenario({
    ...(directory === undefined ? {} : { directory }),
    plugins: [{ name: "asphodel", plugin, settings: options }, ...extra],
  })
  // The load's health probe and bank PUT.
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

/** The system prompt a model call sends. */
const systemText = (call: Call | undefined) =>
  (
    (
      call?.body as {
        messages?: ReadonlyArray<{ role?: string; content?: unknown }>
      }
    )?.messages ?? []
  )
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
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

/** One owner turn that the fake asphodel daemon answers, so the session has its block and the bank is ready. */
const firstTurn = async (
  running: Scenario,
  daemon: ReturnType<typeof Daemon.make>,
  thread: ChatThread.ChatThread,
) => {
  await says(running, thread, "book a table for two")
  await running.fakes.chat.answers(thread, 1)
  return sent(daemon, 3)
}

/** Whether a turn so far took a compaction that rewrote the history, by its log line. */
const compacted = (running: Scenario) =>
  running
    .log()
    .some(
      (line) =>
        line.annotations["event"] === "turn.compaction" &&
        Number(line.annotations["tokens_after"]) <
          Number(line.annotations["tokens_before"]),
    )

test("the plugin loads: the health probe, then the bank PUT with chad's owner ids and timezone and the owner name from its settings", async () => {
  const { load } = await boot()
  expect(load.map(route)).toEqual(["GET /health", "PUT "])
  expect(load[1]?.body).toEqual({
    owner_name: "Tim",
    owner_platform_ids: ["local:owner"],
    assistant_name: "chad",
    timezone: "Pacific/Auckland",
  })
  // With no token set, no request carries an Authorization header.
  expect(load.map((request) => request.authorization)).toEqual([
    undefined,
    undefined,
  ])
})

test("a token written ${ASPHODEL_TOKEN} reaches the asphodel daemon as a bearer token on every request, from the secret store and with the value in no log line", async () => {
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
  const { running, daemon, load } = await boot(
    [],
    { ...settings, token: "${ASPHODEL_TOKEN}" },
    directory,
  )
  const thread = await running.fakes.chat.makeThread("direct")
  await running.fakes.model.script([{ text: "Booked." }])
  const turn = await firstTurn(running, daemon, thread)
  expect([...load, ...turn].map((request) => request.authorization)).toEqual(
    Array(5).fill(`Bearer ${token}`),
  )
  expect(JSON.stringify(running.log())).not.toContain(token)
})

test("a timezone change reloads the plugin, which sends the bank again with the new zone", async () => {
  const { running, daemon } = await boot()
  expect((await running.chad(["timezone", "Europe/Berlin"])).code).toBe(0)
  const reload = await sent(daemon, 2)
  expect(reload.map(route)).toEqual(["GET /health", "PUT "])
  expect(reload[1]?.body).toMatchObject({ timezone: "Europe/Berlin" })
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

test("with ingest set to false two turns each get the block and a prefetch, and no turn reaches the asphodel daemon", async () => {
  const { running, daemon } = await boot([], { ...settings, ingest: false })
  const { fakes } = running
  await fakes.model.script([{ text: "Booked." }, { text: "Friday works." }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "book a table for two")
  await fakes.chat.answers(thread, 1)
  await says(running, thread, "and for Friday?")
  await fakes.chat.answers(thread, 2)
  // An ingest of the first turn would come before the second prefetch.
  const all = await sent(daemon, 3)
  expect(all.map(route)).toEqual([
    "GET /system-prompt",
    "POST /prefetch",
    "POST /prefetch",
  ])
})

test("a message that steers the turn gets no prefetch and joins the ingest's user_text after a blank line", async () => {
  const { running, daemon } = await boot()
  const { fakes } = running
  await fakes.model.script([
    { ...runs('console.log("looking")'), hold: true },
    { text: "Booked for three." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "book a table for two")
  await fakes.model.received(1)
  await says(running, thread, "make it three")
  await fakes.model.release(0)
  await fakes.chat.answers(thread, 1)
  const requests = await sent(daemon, 3)
  expect(requests.map(route)).toEqual([
    "GET /system-prompt",
    "POST /prefetch",
    "POST /turns",
  ])
  expect(requests[1]?.body).toMatchObject({ query: "book a table for two" })
  expect(requests[2]?.body).toMatchObject({
    user_text: "book a table for two\n\nmake it three",
    assistant_text: "Booked for three.",
  })
})

test("a turn a plugin started can recall and is refused memory_forget, and sends no prefetch and no ingest", async () => {
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
console.log(await memory_forget({ ids: ["m7"] }).catch((error) => "refused: " + error.message))`),
    { text: "Nothing new." },
    { text: "Noted." },
  ])
  const direct = await fakes.chat.makeThread("direct")
  thread.resolve(direct)
  await fakes.chat.answers(direct, 1)
  const calls = await fakes.model.calls()
  expect(results(calls[1]).join("\n")).toContain("m7: Tim's dentist is Dr. Lee")
  expect(results(calls[1]).join("\n")).toContain(
    "refused: Only the owner may call memory_forget.",
  )

  // The owner's turn after it runs behind the plugin turn's afterTurn in the plugin's queue, so its ingest is the
  // point by which the plugin turn's hooks have sent all they would.
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

test("with the asphodel daemon down a turn runs without memories and is spooled as one key, and once it is back the next turn's ingest is followed by the spooled turn", async () => {
  const { running, daemon } = await boot()
  const { fakes } = running
  await fakes.model.script([
    { text: "Booked." },
    { text: "Nothing today." },
    { text: "Rain." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await firstTurn(running, daemon, thread)
  const session = openSession(running)

  daemon.state.up = false
  await says(running, thread, "what's on today?")
  await fakes.chat.answers(thread, 2)
  await pluginLogged(running, spooling)
  expect(daemon.state.refused).toBe(2)
  const spooled = await eventually(
    () => keys(running).filter((key) => key.startsWith("spool/")),
    (found) => found.length > 0,
  )
  expect(spooled).toHaveLength(1)
  expect(spooled[0]).toMatch(/^spool\/\d{15}-/)
  // The prefetch failed, so the turn went to the model without memories and its answer was posted.
  const calls = await fakes.model.calls()
  expect(sentText(calls[1])).not.toContain('[memories for "what\'s on today?"')
  expect(await posted(running, thread)).toEqual(["Booked.", "Nothing today."])

  // Two failures leave the breaker closed, and the clock stays inside the fiber's minute, so the next turn's ingest is
  // what replays the spool.
  daemon.state.up = true
  await says(running, thread, "and tomorrow?")
  await fakes.chat.answers(thread, 3)
  const requests = await sent(daemon, 3)
  expect(requests.map(route)).toEqual([
    "POST /prefetch",
    "POST /turns",
    "POST /turns",
  ])
  expect(requests[1]?.body).toMatchObject({ user_text: "and tomorrow?" })
  expect(requests[2]?.body).toMatchObject({
    session_id: session,
    user_text: "what's on today?",
    assistant_text: "Nothing today.",
  })
  await eventually(
    () => keys(running).filter((key) => key.startsWith("spool/")),
    (found) => found.length === 0,
  )
})

test("when the owner says nothing more after an outage, the plugin's background fiber delivers the spooled turn with no turn running", async () => {
  const { running, daemon, clock } = await boot()
  const { fakes } = running
  await fakes.model.script([{ text: "Booked." }, { text: "Nothing today." }])
  const thread = await fakes.chat.makeThread("direct")
  await firstTurn(running, daemon, thread)

  daemon.state.up = false
  await says(running, thread, "what's on today?")
  await fakes.chat.answers(thread, 2)
  await pluginLogged(running, spooling)
  daemon.state.up = true
  expect(daemon.take()).toEqual([])

  // A minute later the fiber's next replay is due.
  clock.advance("1 minute")
  const [replayed] = await sent(daemon, 1)
  expect(replayed && route(replayed)).toBe("POST /turns")
  expect(replayed?.body).toMatchObject({ user_text: "what's on today?" })
  await eventually(
    () => keys(running).filter((key) => key.startsWith("spool/")),
    (found) => found.length === 0,
  )
  expect(
    running
      .log()
      .filter((line) => line.annotations["event"] === "turn.started"),
  ).toHaveLength(2)
})

test("after a compaction the turn's ingest and the session's clear reach the asphodel daemon before the next turn's fresh block fetch and prefetch", async () => {
  const { running, daemon } = await boot()
  const { fakes } = running
  await fakes.model.script([
    // The call says the context is over clanka's threshold, which starts a compaction after the script.
    { ...runs('console.log("ran")'), usage: { input: 250_000, output: 10 } },
    // The turn's own call and the summarizer's, in either order, both held.
    { text: "fine", hold: true },
    { text: "fine", hold: true },
    ...Array.from({ length: 8 }, () => ({ text: "two" })),
  ])
  const thread = await fakes.chat.makeThread("direct")
  // Long enough that clanka has something older than what a compaction keeps.
  await says(running, thread, "a long story. ".repeat(8_000))
  const calls = await fakes.model.received(3)
  const summarizer = calls
    .slice(1)
    .findIndex((call) => results(call).length === 0)
  await fakes.model.release(summarizer === 0 ? 2 : 1)
  await fakes.chat.answers(thread, 1)
  const all = [...(await sent(daemon, 3))]
  const session = openSession(running)

  // The turn that takes the finished summary is the turn that compacted, and the clear follows its ingest.
  await fakes.model.release(summarizer + 1)
  // A turn logs its compaction before its answer is posted, so each turn is known to have compacted or not by then.
  let turns = 1
  while (!compacted(running)) {
    await says(running, thread, "next")
    turns++
    await fakes.chat.answers(thread, turns)
    all.push(...(await sent(daemon, 2)))
  }
  if (!all.some((request) => route(request).endsWith("/clear"))) {
    all.push(...(await sent(daemon, 1)))
  }
  await says(running, thread, "after")
  await fakes.chat.answers(thread, turns + 1)
  all.push(...(await sent(daemon, 3)))
  const clear = all.findIndex((request) => route(request).endsWith("/clear"))
  expect(all.slice(clear - 2).map(route)).toEqual([
    "POST /prefetch",
    "POST /turns",
    `POST /sessions/${session}/clear`,
    "GET /system-prompt",
    "POST /prefetch",
    "POST /turns",
  ])
  expect(all[clear + 1]?.query).toEqual({ session_id: session })
  expect(all[clear + 2]?.body).toEqual({ session_id: session, query: "after" })
  // The fresh block is in the system prompt chad renders again on that turn, in place of the old one.
  const prompt = systemText((await fakes.model.calls()).at(-1))
  expect(prompt).toContain("[asphodel agenda, block-2]")
  expect(prompt).not.toContain("[asphodel agenda, block-1]")
})

test("/new clears the old session and sends nothing else, and the new session's first turn fetches its own block", async () => {
  const { running, daemon } = await boot()
  const { fakes } = running
  await fakes.model.script([{ text: "Booked." }, { text: "Hello again." }])
  const thread = await fakes.chat.makeThread("direct")
  await firstTurn(running, daemon, thread)
  const old = openSession(running)

  await says(running, thread, "/new")
  await fakes.chat.answers(thread, 2)
  const cleared = await sent(daemon, 1)
  expect(cleared.map(route)).toEqual([`POST /sessions/${old}/clear`])

  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 3)
  const requests = await sent(daemon, 3)
  const session = openSession(running)
  expect(session).not.toBe(old)
  expect(requests.map(route)).toEqual([
    "GET /system-prompt",
    "POST /prefetch",
    "POST /turns",
  ])
  expect(requests[0]?.query).toEqual({ session_id: session })
  expect(requests[1]?.body).toEqual({ session_id: session, query: "hello" })
  expect(keys(running)).toEqual([`block/${session}`])
})

test("a session that starts while the asphodel daemon is down: three refused requests open the breaker and the turn is spooled, and once it is back the next turn fetches the block and delivers the spooled turn after its own ingest", async () => {
  const { running, daemon, clock } = await boot()
  const { fakes } = running
  await fakes.model.script([{ text: "Booked." }, { text: "Rain." }])
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
})

test("the plugin unloads at the stop and logs asphodel: unloaded under its name", async () => {
  const { running } = await boot()
  expect(await running.stop()).toBe(0)
  expect(
    running
      .log()
      .filter((line) => line.message === "asphodel: unloaded")
      .map((line) => line.annotations),
  ).toEqual([{ event: "plugin.log", plugin: "asphodel" }])
})
