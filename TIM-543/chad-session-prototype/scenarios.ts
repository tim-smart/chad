// PROTOTYPE for TIM-543. Throwaway. One child process per run: node scenarios.ts <name> [phase]
// run.ts starts these, kills them at chosen events and checks the event log.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as ChatTest from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { HostLive, Incoming, LOG, log, OWNER, registry, Session, type StubPlugin, Turns } from "./chad/host.ts"

const [name, phase = "1"] = process.argv.slice(2)
const variant = process.env.PROTO_VARIANT ?? ""

const events = (): Array<any> => {
  try {
    return readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
/** Wait until enough events from this process match. */
const until = (label: string, pred: (e: any) => boolean, options?: { timeout?: number; count?: number }) =>
  Effect.gen(function*() {
    const deadline = Date.now() + (options?.timeout ?? 90_000)
    while (true) {
      const found = events().filter((e) => e.pid === process.pid && pred(e))
      if (found.length >= (options?.count ?? 1)) return found
      if (Date.now() > deadline) {
        log("scenario.timeout", { label })
        return yield* Effect.die(new Error("timed out waiting for " + label))
      }
      yield* Effect.sleep(25)
    }
  })
const ev = (name: string, extra?: (e: any) => boolean) => (e: any) => e.ev === name && (extra === undefined || extra(e))
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 10)

const setup = Effect.gen(function*() {
  const test = yield* ChatTest.ChatTest
  const sql = yield* SqlClient.SqlClient
  const makeSession = yield* Session.client
  // ChatTest ids are a counter, so the same calls in the same order give the same thread id in every process.
  const thread = yield* test.makeThread()
  const post = (text: string, authorId = OWNER) =>
    Effect.gen(function*() {
      const event: any = yield* test.userPosts(thread, { text, authorId })
      const key = "message/test:" + thread.id + "/" + event.message.id
      log("user.posted", { text: text.slice(0, 70), key })
      yield* test.deliver(event)
      return key
    })
  /** Post and wait for that message's own turn to end. */
  const ask = (text: string, timeout = 120_000) =>
    Effect.gen(function*() {
      const key = yield* post(text)
      yield* until("turn.end " + key, ev("turn.end", (e) => e.key === key), { timeout })
      return key
    })
  const bot = Effect.map(test.messages(thread), (all) => all.filter((m) => m.author.isSelf).map((m) => m.text))
  const count = (query: string) => Effect.map(sql.unsafe<{ c: number }>(query), (rows) => rows[0].c)
  const peek = makeSession(thread.id).peek()
  return { test, thread, post, ask, bot, count, peek, sql, makeSession }
})

/** A plugin that only records what chad hands its hooks. */
const probe = (plugin: string, extra: Partial<StubPlugin> = {}): StubPlugin => ({
  name: plugin,
  beforeTurn: (turn) =>
    Effect.sync(() => void log("hook.beforeTurn", { plugin, turn: turn.id, origin: turn.origin, resumed: turn.resumed, prompt: turn.prompt.slice(0, 40) })),
  afterTurn: (turn, outcome) =>
    Effect.sync(() => log("hook.afterTurn", { plugin, turn: turn.id, origin: turn.origin, resumed: turn.resumed, outcome: outcome._tag, reason: outcome.reason })),
  ...extra
})

let chunkCalls = 0
const plugins: Record<string, () => Array<StubPlugin>> = {
  "kill-resume": () => [probe("probe")],
  "kill-twice": () => [probe("probe")],
  "term-mid-turn": () => [probe("probe")],
  "term-then-kill": () => [probe("probe")],
  "compact-real": () => [probe("probe", { onSession: (event) => Effect.andThen(Effect.sleep(1500), Effect.sync(() => log("hook.compacted", { session: event.session }))) })],
  "compact-gate": () =>
    variant === "fast"
      ? [probe("quick", { onSession: () => Effect.sleep(300) })]
      : [
        probe("quick", { onSession: () => Effect.sleep(300) }),
        // A plugin whose calls hang: the worst case for the wait.
        { name: "slow", afterTurn: () => Effect.never, onSession: () => Effect.never }
      ],
  graceful: () => [{
    name: "slowAfter",
    afterTurn: () => Effect.andThen(Effect.sleep(3000), Effect.sync(() => log("hook.afterTurn.finished", { plugin: "slowAfter" })))
  }],
  chunks: () => [{
    name: "mem",
    chunk: () => {
      const step = ["v1", "v2", "FAIL", "v2", "v3"][chunkCalls++]
      return step === "FAIL" ? Effect.fail("daemon unreachable") : Effect.succeed("memory block " + step)
    }
  }]
}

const chain = Effect.gen(function*() {
  const { thread, post } = yield* setup
  if (phase === "1") {
    if (variant === "before") yield* post("sleep:9000 busy-owner")
    yield* Turns.schedule({ plugin: "cron", name: "job", thread: thread.id, prompt: "sleep:2500 job", everyMs: 4000 })
  }
  yield* until("two more runs saved", ev("timer.nextSaved"), { count: 2, timeout: 60_000 })
  yield* Turns.cancel("cron", "job")
})

const scenarios: Record<string, Effect.Effect<void, any, any>> = {
  // Delivery of a persisted message to the local runner: cold entity, warm entity, plugin turn.
  latency: Effect.gen(function*() {
    const { thread, ask, bot } = yield* setup
    yield* ask("sleep:200 cold")
    yield* ask("sleep:200 warm")
    yield* ask("sleep:200 warm again")
    const outcome = yield* Turns.start({ thread: thread.id, prompt: "sleep:200 plugin turn", plugin: "cron", label: "x" })
    log("turns.start.outcome", { outcome })
    log("bot.messages", { messages: yield* bot })
  }),

  // Real clanka. A message during a turn steers it. A message near the end of a turn either joins it or becomes the next turn.
  steer: Effect.gen(function*() {
    const { post, bot, count, peek, sql, thread } = yield* setup
    const first = yield* post("Run the bash command `sleep 8` and then reply with the word ALPHA.")
    yield* until("script written", ev("brain.scriptEnd"))
    yield* Effect.sleep(2000)
    yield* post("Also include the word BRAVO in your reply.")
    yield* until("first turn end", ev("turn.end", (e) => e.key === first))
    const offsets = [150, 500, 900, 1400, 2000]
    for (let i = 0; i < offsets.length; i++) {
      const outputsBefore = events().filter((e) => e.pid === process.pid && e.ev === "brain.scriptOutput").length
      const turn = yield* post("Run the bash command `sleep 3` and then reply with the word CHARLIE" + i + ".")
      // The script's output is back, so the model's last call of the turn is in flight.
      yield* until("script output " + i, ev("brain.scriptOutput"), { count: outputsBefore + 1 })
      yield* Effect.sleep(offsets[i])
      const late = yield* post("And then also say DELTA" + i + ".")
      log("late.posted", { i, offset: offsets[i], key: late })
      yield* until("late settled " + i, (e) => (e.ev === "message.steered" || e.ev === "turn.end") && e.key === late, { timeout: 120_000 })
      yield* until("turn end " + i, ev("turn.end", (e) => e.key === turn), { timeout: 120_000 })
      const copies = yield* count("SELECT count(*) c FROM session_messages WHERE message LIKE '%also say DELTA" + i + ".%'")
      log("late.inHistory", { i, copies })
    }
    yield* Effect.sleep(500)
    const stats = yield* peek
    const turns = yield* count("SELECT count(*) c FROM turns WHERE state = 'ended'")
    log("steer.stats", { sends: stats.sends, maxActiveSends: stats.maxActiveSends, turnsEnded: turns })
    log("bot.messages", { messages: yield* bot })
    void sql
    void thread
  }),

  // Real clanka. Killed mid-script, then resumed once in a new process.
  "kill-resume": Effect.gen(function*() {
    const { post, bot } = yield* setup
    if (phase === "1") {
      yield* post("Run the bash command `sleep 25; echo finished > done.txt` and then reply with the word OMEGA.")
      return yield* Effect.never
    }
    yield* until("resumed turn end", ev("turn.end"), { timeout: 180_000 })
    yield* until("afterTurn", ev("hook.afterTurn"))
    log("bot.messages", { messages: yield* bot })
  }),

  // Scripted brain. Killed mid-turn twice. The third start gives up.
  "kill-twice": Effect.gen(function*() {
    const { post, bot } = yield* setup
    if (phase === "1") yield* post("sleep:20000 first")
    if (phase !== "3") return yield* Effect.never
    yield* until("gave up", ev("turn.end"))
    yield* until("afterTurn", ev("hook.afterTurn"))
    log("bot.messages", { messages: yield* bot })
  }),

  // Scripted brain. Two graceful stops, then two kills, of one turn. With PROTO_GRACEFUL_FREE only the kills count.
  "term-then-kill": Effect.gen(function*() {
    const { post, bot } = yield* setup
    if (phase === "1") yield* post("sleep:20000 long")
    if (phase !== "5") return yield* Effect.never
    yield* until("gave up", ev("turn.end"))
    yield* until("afterTurn", ev("hook.afterTurn"))
    log("bot.messages", { messages: yield* bot })
  }),

  // Scripted brain. An idle chad with one far-off timer pending: what the storage poll costs.
  "idle-cost": Effect.gen(function*() {
    const { ask, thread } = yield* setup
    yield* ask("sleep:100 warm up")
    yield* Turns.schedule({ plugin: "cron", name: "far", thread: thread.id, prompt: "sleep:100 far", at: Date.now() + 3_600_000 })
    yield* Effect.sleep(2000)
    const before = process.cpuUsage(), started = Date.now()
    yield* Effect.sleep(30_000)
    const used = process.cpuUsage(before)
    log("idle.cpu", { wallMs: Date.now() - started, cpuMs: Math.round((used.user + used.system) / 1000) })
    yield* Turns.cancel("cron", "far")
  }),

  // Scripted brain. A graceful stop mid-turn, then a restart.
  "term-mid-turn": Effect.gen(function*() {
    const { post, bot } = yield* setup
    if (phase === "1") {
      yield* post(variant === "short" ? "sleep:5000 short" : "sleep:15000 long")
      return yield* Effect.never
    }
    if (variant === "short") return yield* Effect.sleep(13_000) // nothing should be redelivered
    yield* until("turn end", ev("turn.end"), { timeout: 60_000 })
    log("bot.messages", { messages: yield* bot })
  }),

  // Real clanka with a low compaction threshold. Does chad learn that a turn compacted, and does the next turn wait?
  "compact-real": Effect.gen(function*() {
    const { ask, post, bot, count } = yield* setup
    const mark = (label: string) => Effect.sync(() => log("mark", { label }))
    yield* mark("turn 1")
    yield* ask(
      variant === "inturn"
        ? "Do these as four separate steps, one script each. Step 1: run a script that prints the full output of the bash command `seq 1 1500` with console.log. Step 2: run a script that prints the word hi. Step 3: run a script that runs the bash command `sleep 15`. Step 4: reply with just OK."
        : "Run a script that prints the full output of the bash command `seq 1 1500` with console.log, and then reply with just OK."
    )
    yield* mark("turn 2")
    yield* ask("Reply with just the word PING.")
    yield* Effect.sleep(variant === "own" ? 12_000 : 500)
    yield* mark("turn 3")
    yield* ask("Reply with just the word PONG.")
    yield* mark("turn 4")
    const next = yield* post("Reply with just the word LAST.")
    yield* until("last turn", ev("turn.end", (e) => e.key === next), { timeout: 120_000 })
    yield* Effect.sleep(2500)
    log("history.rows", { rows: yield* count("SELECT count(*) c FROM session_messages") })
    log("bot.messages", { messages: yield* bot })
  }),

  // Real clanka. Passivate, restore from SQLite, compare the system prompt and the cache numbers.
  passivate: Effect.gen(function*() {
    const { ask, bot, peek } = yield* setup
    yield* ask("Remember this codeword: HERON-42. Reply with just OK.")
    yield* ask("What is 2+2? Reply with just the number.")
    yield* ask("What is 3+3? Reply with just the number.")
    const before = yield* peek
    log("peek", { when: "before", activation: before.activation, system: sha(before.system), systemChars: before.system.length })
    yield* until("passivated", ev("session.passivated"), { timeout: 60_000 })
    yield* ask("What was the codeword? Reply with just the codeword.")
    yield* ask("What is 4+4? Reply with just the number.")
    const after = yield* peek
    log("peek", { when: "after", activation: after.activation, system: sha(after.system), systemChars: after.system.length })
    log("bot.messages", { messages: yield* bot })
  }),

  // Scripted brain. A turn longer than the idle time, then keepAlive.
  idle: Effect.gen(function*() {
    const { ask, makeSession, thread } = yield* setup
    yield* ask("sleep:7000 longer than the idle time")
    yield* makeSession(thread.id).hold({ ms: 9000 })
    yield* until("keepAlive off", ev("keepAlive.off"), { timeout: 30_000 })
    yield* until("passivated", ev("session.passivated"), { timeout: 30_000 })
  }),

  // Real clanka. /stop, a dropped steer, the stored history in a new Agent, then the Stop button.
  stop: Effect.gen(function*() {
    const { post, ask, bot, test } = yield* setup
    const first = yield* post("Run the bash command `sleep 40` and then reply with the word DONE.")
    yield* until("script written", ev("brain.scriptEnd"))
    yield* Effect.sleep(1500)
    yield* post("Also say EXTRA.")
    yield* Effect.sleep(700)
    yield* post("/stop")
    yield* until("stopped", ev("turn.end", (e) => e.key === first))
    yield* until("passivated", ev("session.passivated"), { timeout: 60_000 })
    yield* ask("In one short sentence, what did my first message ask you to do?")
    const second = yield* post("Run the bash command `sleep 40` and then reply with the word DONE2.")
    yield* until("script written again", ev("brain.scriptEnd"), { count: 2 })
    yield* Effect.sleep(1500)
    const status = events().filter((e) => e.pid === process.pid && e.ev === "status.posted").at(-1)
    const started = Date.now()
    const click = yield* test.click(status.id, "stop", { userId: OWNER })
    const reply: any = yield* test.interact(click as any)
    log("button.reply", { reply: reply._tag, ms: Date.now() - started })
    yield* until("stopped by button", ev("turn.end", (e) => e.key === second))
    yield* ask("Reply with just the word ALIVE.")
    yield* post("/stop")
    yield* Effect.sleep(300)
    log("bot.messages", { messages: yield* bot })
  }),

  // Scripted brain. The Stop button alone, for the timing.
  button: Effect.gen(function*() {
    const { post, test } = yield* setup
    const key = yield* post("sleep:20000 long")
    const [status] = yield* until("status", ev("status.posted"))
    yield* Effect.sleep(500)
    const started = Date.now()
    const click = yield* test.click(status.id, "stop", { userId: OWNER })
    const reply: any = yield* test.interact(click as any)
    log("button.reply", { reply: reply._tag, ms: Date.now() - started })
    yield* until("stopped", ev("turn.end", (e) => e.key === key))
  }),

  // Scripted brain. The same chat event delivered again: while cluster still has the request, and after retention pruned it.
  dedupe: Effect.gen(function*() {
    const { test, thread, count } = yield* setup
    const event: any = yield* test.userPosts(thread, { text: "sleep:300 once", authorId: OWNER })
    yield* test.deliver(event)
    yield* until("turn end", ev("turn.end"))
    yield* test.deliver(event)
    yield* Effect.sleep(1500)
    log("dedupe.afterSecond", { delivered: events().filter((e) => e.pid === process.pid && e.ev === "message.delivered").length })
    const rows = () => count("SELECT count(*) c FROM cluster_messages WHERE entity_type = 'Session'")
    while ((yield* rows()) > 0) yield* Effect.sleep(250)
    log("dedupe.pruned", {})
    yield* test.deliver(event)
    yield* Effect.sleep(2000)
    log("dedupe.afterThird", { delivered: events().filter((e) => e.pid === process.pid && e.ev === "message.delivered").length })
  }),

  // Scripted brain. A defect in the handler.
  defect: Effect.gen(function*() {
    const { ask, makeSession, thread, peek } = yield* setup
    if (phase === "2") {
      yield* Effect.sleep(13_000) // longer than the 10s storage poll
      return
    }
    yield* ask("sleep:200 before the defect")
    const exit = yield* makeSession(thread.id).message(
      new Incoming({ key: "defect-1", thread: thread.id, text: "handler-defect", userId: OWNER, sentAt: Date.now() })
    ).pipe(Effect.exit)
    log("defect.exit", { exit: JSON.stringify(exit).slice(0, 300) })
    yield* ask("sleep:200 after the defect")
    log("peek", { activation: (yield* peek).activation })
  }),

  // Timers, scripted brain throughout.
  "timer-basic": Effect.gen(function*() {
    const { thread } = yield* setup
    if (phase === "1") {
      yield* Turns.schedule({ plugin: "cron", name: "soon", thread: thread.id, prompt: "sleep:200 soon", at: Date.now() + 2500 })
      yield* until("soon ran", ev("timer.oneShotDone"))
      yield* Turns.schedule({ plugin: "cron", name: "later", thread: thread.id, prompt: "sleep:200 later", at: Date.now() + 4000 })
      return yield* Effect.never
    }
    yield* until("later ran", ev("timer.oneShotDone"), { timeout: 60_000 })
    yield* Effect.sleep(12_000) // a second delivery would come with the next storage poll
  }),

  "timer-cancel": Effect.gen(function*() {
    const { thread, post, count } = yield* setup
    yield* post("sleep:5000 busy")
    yield* Turns.start({ thread: thread.id, prompt: "sleep:200 queued plugin turn", plugin: "cron", label: "x", wait: false })
    yield* Turns.schedule({ plugin: "cron", name: "gone", thread: thread.id, prompt: "sleep:200 gone", at: Date.now() + 2000 })
    yield* Effect.sleep(500)
    const rows = (entity: string) => count("SELECT count(*) c FROM cluster_messages WHERE entity_type = '" + entity + "'")
    log("rows.beforeCancel", { session: yield* rows("Session"), timer: yield* rows("Timer") })
    yield* Turns.cancel("cron", "gone")
    log("rows.afterCancel", { session: yield* rows("Session"), timer: yield* rows("Timer") })
    yield* until("queued plugin turn ran", ev("turn.end", (e) => String(e.key).startsWith("start/")))
    yield* Effect.sleep(1000)
  }),

  "timer-cancel-run": Effect.gen(function*() {
    const { thread } = yield* setup
    yield* Turns.schedule({ plugin: "cron", name: "job", thread: thread.id, prompt: "sleep:2000 job", everyMs: 3000 })
    yield* until("run started", ev("turn.start"))
    yield* Turns.cancel("cron", "job")
    yield* until("handler saw the cancel", ev("timer.cancelledDuringRun"))
    yield* Effect.sleep(7000)
  }),

  chain,

  "timer-held": Effect.gen(function*() {
    const { thread } = yield* setup
    if (phase === "1") {
      yield* Turns.schedule({ plugin: "cron", name: "held", thread: thread.id, prompt: "sleep:200 held", at: Date.now() + 1500 })
      yield* Turns.schedule({ plugin: "cron", name: "held2", thread: thread.id, prompt: "sleep:200 held2", at: Date.now() + 1500 })
      return yield* Effect.never
    }
    yield* until("held again", ev("timer.held"), { count: 2, timeout: 60_000 })
    yield* Effect.sleep(2000)
    yield* Turns.cancel("cron", "held2")
    registry.load("cron")
    yield* until("held ran", ev("timer.oneShotDone"))
    yield* Effect.sleep(1500)
  }),

  "timer-prune": Effect.gen(function*() {
    const { thread, count } = yield* setup
    yield* Turns.schedule({ plugin: "cron", name: "job", thread: thread.id, prompt: "sleep:300 job", everyMs: 2500 })
    for (let i = 0; i < 9; i++) {
      yield* Effect.sleep(2000)
      log("prune.rows", {
        timerProcessed: yield* count("SELECT count(*) c FROM cluster_messages WHERE entity_type = 'Timer' AND processed = 1"),
        timerPending: yield* count("SELECT count(*) c FROM cluster_messages WHERE entity_type = 'Timer' AND processed = 0"),
        sessionProcessed: yield* count("SELECT count(*) c FROM cluster_messages WHERE entity_type = 'Session' AND processed = 1"),
        replies: yield* count("SELECT count(*) c FROM cluster_replies")
      })
    }
    yield* Turns.cancel("cron", "job")
  }),

  // Real clanka. A loop-side tool queues a turn for its own thread and returns.
  "tool-queue": Effect.gen(function*() {
    const { post, bot } = yield* setup
    yield* post("Call the queueTurn tool with the prompt \"Reply with just the word QUEUED-RAN\". Then reply to me with the status it returned.")
    yield* until("both turns ended", ev("turn.end"), { count: 2, timeout: 120_000 })
    log("bot.messages", { messages: yield* bot })
  }),

  // Scripted brain. After a turn that compacted, the next turn waits for the queued hooks.
  "compact-gate": Effect.gen(function*() {
    const { ask, post, bot } = yield* setup
    yield* ask("sleep:200 compact")
    const next = yield* post("sleep:200 the message that arrived in the meantime")
    yield* until("next turn end", ev("turn.end", (e) => e.key === next), { timeout: 80_000 })
    log("bot.messages", { messages: yield* bot })
  }),

  // Scripted brain. A hook queued off the reply path, then a graceful stop or a kill.
  graceful: Effect.gen(function*() {
    const { post } = yield* setup
    yield* post("sleep:200 hi")
    return yield* Effect.never
  }),

  // Scripted brain. A prompt chunk that changes, fails to render, and changes again.
  chunks: Effect.gen(function*() {
    const { ask, count } = yield* setup
    for (let i = 1; i <= 5; i++) yield* ask("sleep:100 turn " + i)
    log("chunks.updatesInHistory", { rows: yield* count("SELECT count(*) c FROM session_messages WHERE message LIKE '%<environment-update>%'") })
  })
}

registry.plugins.push(...(plugins[name]?.() ?? []))
if (name === "timer-held") registry.unloaded.add("cron")

const main = Effect.gen(function*() {
  log("scenario.start", { name, phase, variant })
  yield* scenarios[name]
  log("scenario.end", { name, phase })
})

main.pipe(Effect.provide(HostLive as Layer.Layer<any, any, never>), NodeRuntime.runMain)
