// PROTOTYPE for TIM-539. Throwaway. Runs the asphodel plugin on the stand-in
// host against the fake daemon and prints what the daemon and the model see.
// Run: npm run scenarios
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"
import asphodel from "../plugins/asphodel.ts"
import * as Host from "../chad/_host.ts"
import * as FakeDaemon from "./fake-daemon.ts"

const daemon = FakeDaemon.make()
let failed = 0
const title = (text: string) => Effect.sync(() => console.log(`\n== ${text}`))
const check = (label: string, pass: boolean) =>
  Effect.sync(() => {
    if (!pass) failed++
    console.log(`  ${pass ? "PASS" : "FAIL"}    ${label}`)
  })
const routes = () => daemon.take().map((request) => `${request.method} ${request.path.replace("/v1/banks/chad", "")}`)
const answer = (text: string) => () => Effect.succeed({ answer: text })

const program = Effect.gen(function*() {
  // A test clock, so the breaker's 30s and the spool's one minute can pass at once.
  yield* TestClock.setTime(Date.parse("2026-11-14T09:00:00Z"))
  const host = yield* Host.make({
    name: "asphodel",
    plugin: asphodel,
    http: daemon.client,
    owners: ["discord:1234"],
    zone: "Pacific/Auckland",
    config: { url: "http://asphodel:7720", ownerName: "Tim" }
  })

  yield* title("1. Load. Hermes: initialize")
  yield* host.load
  const loadRequests = daemon.take()
  yield* check("health probe, then the bank PUT", loadRequests.map((r) => r.method).join(" ") === "GET PUT")
  yield* check(
    "the bank gets the owner ids and the timezone from chad, not from plugin config",
    loadRequests[1]?.body.owner_platform_ids[0] === "discord:1234" && loadRequests[1]?.body.timezone === "Pacific/Auckland"
  )

  yield* title("2. Two owner turns in a DM. Hermes: system_prompt_block, prefetch, sync_turn")
  const dm = host.session("direct")
  yield* host.turn(dm, { text: "when is my dentist appointment?" }, answer("Tuesday at 3pm."))
  yield* host.drain
  const first = daemon.take()
  yield* check("one block fetch with the session id, one prefetch, one ingest",
    first.map((r) => r.path.split("/").at(-1)).join(" ") === "system-prompt prefetch turns" && first[0]?.query.session_id === dm.id)
  yield* check("the ingest echoes the prefetch's recall id and names the author",
    first[2]?.body.recall_id === "recall-1" && first[2]?.body.author.id === "1234" && first[2]?.body.platform === "discord")
  yield* host.turn(dm, { text: "move it to Friday" }, answer("Done."))
  yield* host.drain
  const second = daemon.take()
  yield* check("the second turn does not fetch the block again", !second.some((r) => r.path.endsWith("/system-prompt")))
  yield* check("its prefetch carries the previous query and reply",
    second[0]?.body.previous_query === "when is my dentist appointment?" && second[0]?.body.previous_reply === "Tuesday at 3pm.")

  yield* title("3. A message steers the turn")
  yield* host.turn(dm, { text: "book a table for two" }, () => Effect.succeed({ answer: "Booked for three.", steers: ["make it three"] }))
  yield* host.drain
  const steered = daemon.take()
  yield* check("no prefetch ran for the steering message", steered.filter((r) => r.path.endsWith("/prefetch")).length === 1)
  yield* check("the ingest's user_text holds both messages", steered.at(-1)?.body.user_text === "book a table for two\n\nmake it three")

  yield* title("4. A cron turn. Hermes: agent_context is not primary")
  let refused = ""
  yield* host.turn(dm, { cron: "morning briefing" }, (tools) =>
    Effect.gen(function*() {
      yield* tools.call("memory_recall", { query: "today" })
      refused = yield* tools.call("memory_forget", { ids: ["m7"] })
      return { answer: "Good morning." }
    }))
  yield* host.drain
  const cron = routes()
  yield* check("memory_recall works and memory_forget is refused", cron.join() === "POST /recall" && refused.includes("Only the owner"))
  yield* check("no prefetch and no ingest", !cron.includes("POST /prefetch") && !cron.includes("POST /turns"))

  yield* title("5. The owner asks to forget. Hermes: the memory_forget scan and forget_requested")
  yield* host.turn(dm, { text: "forget my dentist" }, (tools) =>
    Effect.gen(function*() {
      // A sub-agent's call arrives exactly like this one. The handler cannot tell them apart.
      yield* tools.call("memory_forget", { ids: ["m7"] })
      return { answer: "Forgotten." }
    }))
  yield* host.drain
  const forget = daemon.take()
  yield* check("the forget carries the session id", forget.find((r) => r.path.endsWith("/forget"))?.body.session_id === dm.id)
  yield* check("the turn is ingested with forget_requested", forget.at(-1)?.body.forget_requested === true)
  yield* host.turn(dm, { text: "thanks" }, answer("Any time."))
  yield* host.drain
  yield* check("the next prefetch does not send the forget request as previous_query", daemon.take()[0]?.body.previous_query === undefined)

  yield* title("6. A background task calls a tool after its turn ended")
  const late = yield* host.callTool(dm, "memory_keep", { ids: ["m7"] })
  yield* check("memory_keep is refused, because there is no turn", late.includes("Only the owner") && routes().length === 0)

  yield* title("7. The daemon is down for a turn. Hermes: the spool")
  daemon.state.up = false
  yield* host.turn(dm, { text: "I got a new job at Acme" }, answer("Congratulations!"))
  yield* host.drain
  yield* check("the turn ran without memories and was spooled", (yield* host.storeKeys).filter((key) => key.startsWith("spool/")).length === 1)
  daemon.state.up = true
  yield* host.turn(dm, { text: "I start on Monday" }, answer("Noted."))
  yield* host.drain
  const back = daemon.take().filter((r) => r.path.endsWith("/turns")).map((r) => r.body.user_text)
  yield* check("the next ingest is followed by the spooled turn", back.join(" | ") === "I start on Monday | I got a new job at Acme")
  yield* check("the spool is empty", !(yield* host.storeKeys).some((key) => key.startsWith("spool/")))

  yield* title("7b. The same, and the owner says nothing more. The plugin's own fiber replays the spool")
  daemon.state.up = false
  yield* host.turn(dm, { text: "my manager is called Priya" }, answer("Got it."))
  yield* host.drain
  daemon.state.up = true
  daemon.take()
  yield* TestClock.adjust("1 minute")
  yield* check("a minute later the spooled turn is delivered with no turn running",
    daemon.take().map((r) => r.body?.user_text).join() === "my manager is called Priya")

  yield* title("8a. A compaction, with the Compacted hook finished before the next turn (the proposed rule)")
  yield* host.turn(dm, { text: "summarise this week" }, () => Effect.succeed({ answer: "Here it is.", compacted: true }))
  yield* host.drain
  yield* host.turn(dm, { text: "and next week?" }, answer("Quiet."))
  yield* host.drain
  const ordered = routes()
  yield* check("order: ingest, clear, a fresh block, prefetch",
    ordered.slice(0, 5).join(" > ") === `POST /prefetch > POST /turns > POST /sessions/${dm.id}/clear > GET /system-prompt > POST /prefetch`)

  yield* title("8b. The same, but the next turn starts before the hooks have run (today's rule)")
  yield* host.turn(dm, { text: "summarise this month" }, () => Effect.succeed({ answer: "Here it is.", compacted: true }))
  yield* host.turn(dm, { text: "and next month?" }, answer("Busy."))
  yield* host.drain
  const raced = routes()
  yield* check("the new system prompt froze the old block, because no fetch came before the second prefetch",
    raced.slice(0, 2).join(" > ") === "POST /prefetch > POST /prefetch")
  yield* check("the clear then wipes what that prefetch injected, so its recall id commits nothing",
    raced.indexOf(`POST /sessions/${dm.id}/clear`) > 1)
  yield* host.turn(dm, { text: "ok" }, answer("Ok."))
  yield* host.drain
  yield* check("the turn after that fetches a new block, which reaches the model as an update message",
    routes()[0] === "GET /system-prompt")

  yield* title("9. /new. Hermes: on_session_switch(reset)")
  const fresh = yield* host.reset(dm)
  yield* host.drain
  yield* check("the old session is cleared", routes().join() === `POST /sessions/${dm.id}/clear`)
  yield* host.turn(fresh, { text: "hello again" }, answer("Hello."))
  yield* host.drain
  yield* check("the new session fetches its own block", daemon.take()[0]?.query.session_id === fresh.id)

  yield* title("10. The process restarts in the middle of a turn")
  const cut = yield* host.turn(fresh, { text: "plan my trip to Tokyo" }, () => Effect.succeed({ cut: true }))
  yield* host.restart
  daemon.take()
  yield* host.turn(fresh, { text: "plan my trip to Tokyo", resume: cut }, answer("Here is a plan."))
  yield* host.drain
  const resumed = daemon.take()
  yield* check("the resumed turn does not prefetch again", !resumed.some((r) => r.path.endsWith("/prefetch")))
  const ingest = resumed.find((r) => r.path.endsWith("/turns"))?.body
  yield* check("it is ingested once, with the owner's message and the first attempt's recall id",
    ingest?.user_text === "plan my trip to Tokyo" && typeof ingest?.recall_id === "string" && ingest.recall_id.startsWith("recall-"))
  yield* check("the restart did not fetch a second block, because the first is in the store",
    !resumed.some((r) => r.path.endsWith("/system-prompt")))

  yield* title("11. A session starts while the daemon is down. Hermes: breaker.py")
  daemon.state.up = false
  daemon.state.refused = 0
  const thread = host.session("thread")
  yield* host.turn(thread, { text: "remind me what we decided" }, answer("I can't reach my memory right now."))
  yield* host.drain
  yield* check("after three refused connections the breaker stops asking, and the turn is spooled",
    daemon.state.refused === 3 && (yield* host.storeKeys).some((key) => key.startsWith("spool/")))
  daemon.state.up = true
  yield* TestClock.adjust("31 seconds")
  yield* host.turn(thread, { text: "try again" }, answer("We decided on Friday."))
  yield* host.drain
  const recovered = daemon.take()
  yield* check("the next turn gets the block, which reaches the model as an update message",
    recovered[0]?.path.endsWith("/system-prompt") === true && recovered[0]?.query.session_id === thread.id)
  yield* check("and the spooled turn is delivered", recovered.filter((r) => r.path.endsWith("/turns")).length === 2)

  yield* title("12. Unload. Hermes: shutdown")
  yield* host.unload

  console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} checks FAILED.`)
})

Effect.runPromise(Effect.provide(program, TestClock.layer())).then(() => process.exit(failed === 0 ? 0 : 1))
