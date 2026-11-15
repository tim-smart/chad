// PROTOTYPE for "The plugin swap run with live sessions" (TIM-552). Throwaway.
// One child process per run: node scenarios.ts <name> [phase]
// run.ts starts these, sends signals at chosen events and checks the event log.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as ChatTest from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HostLive, OWNER, release, Turns } from "./chad/host.ts"
import { LOG, log } from "./chad/log.ts"
import * as Plugins from "./chad/plugins.ts"

const [name, phase = "1"] = process.argv.slice(2)

const events = (): Array<any> => {
  try {
    return readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
const until = (label: string, pred: (e: any) => boolean, options?: { timeout?: number; count?: number }) =>
  Effect.gen(function*() {
    const deadline = Date.now() + (options?.timeout ?? 60_000)
    while (true) {
      const found = events().filter((e) => e.pid === process.pid && pred(e))
      if (found.length >= (options?.count ?? 1)) return found
      if (Date.now() > deadline) {
        log("scenario.timeout", { label })
        return yield* Effect.die(new Error("timed out waiting for " + label))
      }
      yield* Effect.sleep(20)
    }
  })
const ev = (name: string, extra?: (e: any) => boolean) => (e: any) => e.ev === name && (extra === undefined || extra(e))
const marked = (label: string) => until("mark " + label, ev("script.mark", (e) => e.label === label))

// --- what a script is made of ---------------------------------------------------------------

const call = (tool: string, params: object) =>
  "try { console.log('OK ' + JSON.stringify(await " + tool + "(" + JSON.stringify(params) + "))) } catch (e) { console.log('ERR ' + (e && e.message ? e.message : String(e))) }"
const mark = (label: string) => "await mark({ label: " + JSON.stringify(label) + " })"
const hold = (label: string) => "await hold({ label: " + JSON.stringify(label) + " })"
/** One script per step. A step is a list of statements. */
const plan = (steps: Array<Array<string>>, complete = false) =>
  "PLAN:" + JSON.stringify({ steps: steps.map((s) => s.join("\n")), ...(complete ? { complete: true } : {}) })

// --- the plugins a scenario writes into work/ -------------------------------------------------

interface EchoOptions {
  readonly label: string
  readonly description?: string
  readonly slow?: boolean
  /** ms the afterTurn hook takes; undefined registers none. */
  readonly afterTurn?: number
  readonly afterTurnTimeout?: number
  readonly compacted?: boolean
  readonly hangClose?: boolean
  readonly background?: boolean
}
/** Keeps or drops the //#if blocks of a template in seed/ and fills its __NAMES__. */
const render = (file: string, flags: Record<string, boolean>, vars: Record<string, string> = {}) => {
  const out: Array<string> = []
  let keep = true
  for (const line of readFileSync(join(import.meta.dirname, "seed", file), "utf8").split("\n")) {
    const open = /^\s*\/\/#if (\w+)/.exec(line)
    if (open) keep = flags[open[1]] === true
    else if (/^\s*\/\/#endif/.test(line)) keep = true
    else if (keep) out.push(line)
  }
  return out.join("\n").replace(/__([A-Z_]+)__/g, (_, key) => vars[key])
}
const echoSource = (o: EchoOptions) =>
  render("echo.ts", { slow: o.slow !== false, afterTurn: o.afterTurn !== undefined, compacted: o.compacted === true, hangClose: o.hangClose === true, background: o.background === true }, {
    LABEL: o.label,
    DESCRIPTION: o.description ?? "Echo the text back.",
    AFTER_MS: String(o.afterTurn),
    AFTER_TIMEOUT: String(o.afterTurnTimeout ?? 30_000)
  })
const pickySource = render("picky.ts", {})
const shapedSource = render("shaped.ts", {})
const stubbornSource = (label: string) => render("stubborn.ts", {}, { LABEL: label })
const convSource = (v: 1 | 2) => render("conv.ts", { v1: v === 1, v2: v === 2 })

const plugins = join(Plugins.WORK, "plugins")
const write = (plugin: string, source: string) => {
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, plugin + ".ts"), source)
}
const remove = (plugin: string) => rmSync(join(plugins, plugin + ".ts"), { force: true })
const settings = (value: object) => writeFileSync(join(Plugins.WORK, "chad.json"), JSON.stringify(value, null, 2))
const applied = (label: string) =>
  Effect.gen(function*() {
    const result = yield* Plugins.apply
    log("cli.apply", { label, ...result })
    return result
  })
const reloaded = (options: Parameters<typeof Plugins.reload>[0]) =>
  Effect.gen(function*() {
    const result = yield* Plugins.reload(options)
    log("cli.reload", { ...result, reason: options.reason })
    return result
  })

const setup = Effect.gen(function*() {
  const test = yield* ChatTest.ChatTest
  // ChatTest ids are a counter, so the same calls in the same order give the same thread ids in every process.
  const threads = { A: yield* test.makeThread(), B: yield* test.makeThread(), C: yield* test.makeThread() }
  const post = (who: keyof typeof threads, text: string) =>
    Effect.gen(function*() {
      const thread = threads[who]
      const event: any = yield* test.userPosts(thread, { text, authorId: OWNER })
      const key = "message/test:" + thread.id + "/" + event.message.id
      log("user.posted", { who, key, text: text.slice(0, 60) })
      yield* test.deliver(event)
      return key
    })
  const ended = (key: string, timeout = 60_000) => until("turn.end " + key, ev("turn.end", (e) => e.key === key), { timeout })
  const ask = (who: keyof typeof threads, text: string, timeout?: number) =>
    Effect.gen(function*() {
      const key = yield* post(who, text)
      const [end] = yield* ended(key, timeout)
      log("answer", { who, key, text: end.text })
      return key
    })
  return { test, threads, post, ask, ended }
})
const first = phase === "1"

const scenarios: Record<string, Effect.Effect<void, any, any>> = {
  // The wrapper looks the version up per call, and a reload that keeps the code reaches a running turn.
  route: Effect.gen(function*() {
    const { post, ended } = yield* setup
    write("echo", echoSource({ label: "v1" }))
    settings({ plugins: { echo: { settings: { greeting: "hi" } } } })
    yield* applied("first")
    const key = yield* post("A", "one turn, four calls " + plan([[
      call("echo", { text: "a" }), mark("m1"), hold("h1"),
      call("echo", { text: "b" }), mark("m2"), hold("h2"),
      call("echo", { text: "c" }), mark("m3"), hold("h3"),
      call("echo", { text: "d" })
    ]]))
    yield* marked("m1")
    yield* reloaded({ names: ["echo"], reason: "chad plugin reload" })
    yield* release("h1")
    yield* marked("m2")
    Plugins.globals.timezone = "Europe/London"
    yield* reloaded({ reason: "timezone" })
    yield* release("h2")
    yield* marked("m3")
    settings({ plugins: { echo: { settings: { greeting: "yo" } } } })
    yield* applied("settings only")
    yield* release("h3")
    const [end] = yield* ended(key)
    log("answer", { who: "A", key, text: end.text })
  }),

  // An apply that changed the code, a removed tool, safe mode. The turn carries on each time.
  changed: Effect.gen(function*() {
    const { post, ask, ended, threads } = yield* setup
    write("echo", echoSource({ label: "v1" }))
    yield* applied("first")
    const a = yield* post("A", "code change " + plan([[call("echo", { text: "a1" }), mark("a1"), hold("ha"), call("echo", { text: "a2" })], [call("slow", { ms: 10, tag: "a3" })], ["console.log('the turn carried on')"]]))
    const b = yield* post("B", "another session " + plan([[mark("b1"), hold("hb"), call("echo", { text: "b1" })]]))
    yield* marked("a1")
    yield* marked("b1")
    write("echo", echoSource({ label: "v2" }))
    yield* applied("code change")
    yield* release("ha")
    yield* release("hb")
    log("answer", { who: "A", key: a, text: (yield* ended(a))[0].text })
    log("answer", { who: "B", key: b, text: (yield* ended(b))[0].text })
    yield* ask("A", "next turn " + plan([[call("echo", { text: "a4" })]]))

    const c = yield* post("A", "removed tool " + plan([[call("slow", { ms: 10, tag: "c1" }), mark("c1"), hold("hc"), call("slow", { ms: 10, tag: "c2" }), call("echo", { text: "c3" })]]))
    yield* marked("c1")
    write("echo", echoSource({ label: "v3", slow: false }))
    yield* applied("tool removed")
    yield* release("hc")
    log("answer", { who: "A", key: c, text: (yield* ended(c))[0].text })

    const d = yield* post("A", "safe mode " + plan([[call("echo", { text: "d1" }), mark("d1"), hold("hd"), call("echo", { text: "d2" })]]))
    yield* marked("d1")
    yield* Plugins.safe(true)
    yield* release("hd")
    log("answer", { who: "A", key: d, text: (yield* ended(d))[0].text })
    // A timer of a plugin that safe mode turned off is held, and runs once the plugin is back.
    yield* Turns.schedule({ plugin: "echo", name: "job", thread: threads.C.id, prompt: "a timer whose plugin was off " + plan([[call("echo", { text: "timer" })]]), at: Date.now() + 200 })
    yield* until("timer delivered", ev("timer.delivered"))
    yield* Effect.sleep(1000)
    log("safe.stillOn", { timerTurnStarted: events().some((x) => x.ev === "turn.start" && String(x.key).startsWith("timer/")) })
    yield* Plugins.safe(false)
    const [timer] = yield* until("timer turn", ev("turn.end", (x) => String(x.key).startsWith("timer/")))
    log("answer", { who: "C", key: timer.key, text: timer.text })
    yield* ask("A", "after safe off " + plan([[call("echo", { text: "e1" })]]))
    log("status", { status: Plugins.status() })
  }),

  // The gate: a call that arrives during a swap is held for the activation, or refused at once.
  gate: Effect.gen(function*() {
    const { post, ended } = yield* setup
    write("echo", echoSource({ label: "v1" }))
    yield* applied("first")
    // C's Agent is built on the v1 bundle and its turn stays open.
    const c = yield* post("C", "an old bundle " + plan([[call("echo", { text: "c0" }), mark("c1"), hold("hc"), call("echo", { text: "c-during-swap" })]]))
    yield* marked("c1")
    write("echo", echoSource({ label: "v2" }))
    yield* applied("code change")
    // A and B are built on v2.
    const a = yield* post("A", "in flight " + plan([[call("slow", { ms: 3000, tag: "a" })]]))
    const b = yield* post("B", "arrives during the swap " + plan([[mark("b1"), hold("hb"), call("echo", { text: "b-during-swap" })]]))
    yield* marked("b1")
    yield* until("slow started", ev("plugin.slow.start"))
    const fiber = yield* Effect.forkChild(reloaded({ names: ["echo"], reason: "chad plugin reload" }))
    yield* until("gate closed", ev("swap.gateClosed", (e) => e.label.startsWith("reload")))
    yield* release("hb")
    yield* release("hc")
    for (const [who, key] of [["A", a], ["B", b], ["C", c]] as const) log("answer", { who, key, text: (yield* ended(key))[0].text })
    yield* Fiber.await(fiber)
  }),

  // The real constants. A tool call and a hook that outlast the 30s drain, a finalizer that
  // outlasts the 10s close, a turn that starts during the swap and a timer that fires during it.
  deadlines: Effect.gen(function*() {
    const { post, ask, ended, threads } = yield* setup
    write("echo", echoSource({ label: "v1", afterTurn: 100_000, afterTurnTimeout: 120_000, hangClose: true }))
    yield* applied("first")
    yield* ask("A", "a turn whose afterTurn hook hangs " + plan([[call("echo", { text: "a1" })]]))
    yield* until("hook running", ev("plugin.afterTurn.start"))
    const a2 = yield* post("A", "a call that hangs " + plan([[call("slow", { ms: 100_000, tag: "a2" })], [call("echo", { text: "after the cut" })]]))
    yield* until("slow started", ev("plugin.slow.start"))
    write("echo", echoSource({ label: "v2", afterTurn: 50 }))
    const fiber = yield* Effect.forkChild(applied("code change"))
    const [closed] = yield* until("gate closed", ev("swap.gateClosed", (e) => e.label === "apply" && e.plugins.some((p: string) => p.startsWith("echo: echo#1@"))))
    const b = yield* post("B", "a turn that starts during the swap " + plan([[call("echo", { text: "b1" })]]))
    yield* Turns.schedule({ plugin: "echo", name: "job", thread: threads.C.id, prompt: "a timer that fired during the swap " + plan([[call("echo", { text: "timer" })]]), at: closed.t + 2000 })
    log("answer", { who: "A", key: a2, text: (yield* ended(a2, 90_000))[0].text })
    log("answer", { who: "B", key: b, text: (yield* ended(b, 90_000))[0].text })
    const [timer] = yield* until("timer turn", ev("turn.end", (e) => String(e.key).startsWith("timer/")), { timeout: 90_000 })
    log("answer", { who: "C", key: timer.key, text: timer.text })
    yield* Fiber.await(fiber)
    yield* until("the queued afterTurn hooks ran", ev("hook.done", (e) => e.on?.includes("#2@")), { count: 2, timeout: 30_000 })
  }),

  // Hooks queued off the reply path run on the new version. A kind it no longer registers is dropped.
  hooks: Effect.gen(function*() {
    const { ask } = yield* setup
    write("echo", echoSource({ label: "v1", afterTurn: 1500, compacted: true, background: true }))
    yield* applied("first")
    yield* ask("A", "t1 " + plan([[call("echo", { text: "t1" })]]))
    yield* ask("A", "t2 COMPACTED " + plan([[call("echo", { text: "t2" })]]))
    yield* ask("A", "t3 " + plan([[call("echo", { text: "t3" })]]))
    write("echo", echoSource({ label: "v2", afterTurn: 100 }))
    yield* applied("code change, no onSession")
    yield* until("queued hooks done", (e) => e.ev === "hook.done" || e.ev === "hook.dropped", { count: 4 })
    // A removed plugin's queued hooks are dropped.
    write("echo", echoSource({ label: "v3", afterTurn: 1500 }))
    yield* applied("slower hook again")
    yield* ask("A", "t4 " + plan([[call("echo", { text: "t4" })]]))
    yield* ask("A", "t5 " + plan([[call("echo", { text: "t5" })]]))
    remove("echo")
    yield* applied("plugin removed")
    yield* until("all hooks settled", (e) => e.ev === "hook.done" || e.ev === "hook.dropped", { count: 6 })
    log("status", { status: Plugins.status() })
  }),

  // A reload that is not an apply, with one plugin that fails to build.
  "reload-fail": Effect.gen(function*() {
    const { ask } = yield* setup
    Plugins.globals.owners = ["owner-1", "owner-2"]
    write("echo", echoSource({ label: "v1" }))
    write("picky", pickySource)
    yield* applied("first")
    yield* ask("A", "before " + plan([[call("echo", { text: "x" }), call("pick", {})]]))
    Plugins.globals.timezone = "Mars/Olympus"
    yield* reloaded({ reason: "timezone" })
    log("status", { after: "timezone", status: Plugins.status() })
    yield* ask("A", "after the timezone change " + plan([[call("echo", { text: "x" }), call("pick", {})]]))
    // An owner is removed. picky still fails to build, so it is unloaded.
    Plugins.globals.owners = ["owner-1"]
    yield* reloaded({ reason: "owner", ownerRemoved: true })
    log("status", { after: "owner removed", status: Plugins.status() })
    yield* ask("A", "after the owner was removed " + plan([[call("echo", { text: "x" }), call("pick", {})]]))
  }),

  // A graceful stop while a swap is draining. Phase 2 is the next boot.
  "stop-drain": Effect.gen(function*() {
    const { post, ask, ended } = yield* setup
    if (first) {
      write("echo", echoSource({ label: "v1", afterTurn: 300 }))
      yield* applied("first")
      yield* ask("A", "quick " + plan([[call("echo", { text: "a1" })]]))
      yield* post("A", "in flight at the stop " + plan([[call("slow", { ms: 20_000, tag: "a2" })]]))
      yield* until("slow started", ev("plugin.slow.start"))
      // B's call is held at the gate when the stop arrives.
      yield* post("B", "held at the gate " + plan([[mark("b1"), hold("hb"), call("echo", { text: "b-held" })]]))
      yield* marked("b1")
      yield* Effect.forkChild(reloaded({ names: ["echo"], reason: "chad plugin reload" }))
      yield* until("gate closed", ev("swap.gateClosed", (e) => e.label.startsWith("reload")))
      yield* release("hb")
      return yield* Effect.never
    }
    yield* until("the cut turn resumed and ended", ev("turn.end"), { timeout: 60_000 })
    log("status", { status: Plugins.status() })
  }),

  // The same, with an apply that changed the code: the commit has happened, the activation has not.
  "stop-apply": Effect.gen(function*() {
    const { post, ask } = yield* setup
    if (first) {
      write("echo", echoSource({ label: "v1", afterTurn: 1500 }))
      yield* applied("first")
      // Two quick turns in another session: one afterTurn hook running at the stop, one queued.
      yield* ask("B", "quick " + plan([[call("echo", { text: "b1" })]]))
      yield* ask("B", "quick " + plan([[call("echo", { text: "b2" })]]))
      yield* post("A", "in flight at the stop " + plan([[call("slow", { ms: 20_000, tag: "a2" })], [call("echo", { text: "after" })]]))
      yield* until("slow started", ev("plugin.slow.start"))
      write("echo", echoSource({ label: "v2", afterTurn: 300 }))
      yield* Effect.forkChild(applied("code change"))
      return yield* Effect.never
    }
    yield* until("the cut turn resumed and ended", ev("turn.end"), { timeout: 60_000 })
    log("status", { status: Plugins.status() })
  }),

  // A stop before the commit: nothing changes.
  "stop-before-commit": Effect.gen(function*() {
    const { ask } = yield* setup
    if (first) {
      write("echo", echoSource({ label: "v1" }))
      yield* applied("first")
      write("echo", echoSource({ label: "v2" }))
      yield* Effect.forkChild(applied("code change"))
      return yield* Effect.never
    }
    yield* ask("A", "after the boot " + plan([[call("echo", { text: "a1" })]]))
    log("status", { status: Plugins.status() })
  }),

  // A stop while the old scope is closing: the plugin is between its close and its activation.
  "stop-close": Effect.gen(function*() {
    const { ask, post } = yield* setup
    if (first) {
      write("echo", echoSource({ label: "v1", afterTurn: 2500, hangClose: true }))
      yield* applied("first")
      yield* ask("A", "t1 " + plan([[call("echo", { text: "t1" })]]))
      yield* ask("A", "t2 " + plan([[call("echo", { text: "t2" })]]))
      // B's turn is running. It calls once while the old version is closing, and again after the stop.
      yield* post("B", "calls between the close and the activation " + plan([[mark("b1"), hold("hb"), call("echo", { text: "b-closing" }), "await pause({ ms: 1200 })", call("echo", { text: "b-after-the-stop" })]]))
      yield* marked("b1")
      write("echo", echoSource({ label: "v2", afterTurn: 100 }))
      yield* Effect.forkChild(applied("code change"))
      yield* until("old version closing", ev("plugin.closing", (e) => e.instance === 1))
      yield* release("hb")
      return yield* Effect.never
    }
    yield* release("hb")
    const [resumed] = yield* until("the cut turn resumed and ended", ev("turn.end"), { timeout: 60_000 })
    log("answer", { who: "B", key: resumed.key, text: resumed.text })
    yield* ask("C", "after the boot " + plan([[call("echo", { text: "a1" })]]))
    log("status", { status: Plugins.status() })
  }),

  // Calls from a sub-agent and from a background sub-agent follow the same rules.
  subagent: Effect.gen(function*() {
    const { post, ended } = yield* setup
    write("echo", echoSource({ label: "v1" }))
    yield* applied("first")
    const child = (tag: string) =>
      "TASK-" + tag + " " + plan([[
        call("echo", { text: tag + "1" }), mark(tag + "1"), hold("h1" + tag),
        call("echo", { text: tag + "2" }), mark(tag + "2"), hold("h2" + tag),
        call("echo", { text: tag + "3" })
      ]], true) + "\n"
    const key = yield* post("A", "sub-agents " + plan([[
      "const bg = await subagent({ prompt: " + JSON.stringify(child("bg")) + ", background: true })",
      "console.log('started ' + JSON.stringify(bg))",
      "const fg = await subagent({ prompt: " + JSON.stringify(child("fg")) + " })",
      "console.log('foreground: ' + JSON.stringify(fg))",
      "const done = await waitTasks({ ids: [typeof bg === 'string' ? bg : bg.id] })",
      "console.log('background: ' + JSON.stringify(done))"
    ]]))
    yield* marked("bg1")
    yield* marked("fg1")
    yield* reloaded({ names: ["echo"], reason: "chad plugin reload" })
    yield* release("h1bg")
    yield* release("h1fg")
    yield* marked("bg2")
    yield* marked("fg2")
    write("echo", echoSource({ label: "v2" }))
    yield* applied("code change")
    yield* release("h2bg")
    yield* release("h2fg")
    log("answer", { who: "A", key, text: (yield* ended(key))[0].text })
  }),

  // The same bundle with other settings: a declaration built from a setting, and a schema that
  // changes behind an unchanged declaration.
  shape: Effect.gen(function*() {
    const { post, ended } = yield* setup
    write("shaped", shapedSource)
    settings({ plugins: { shaped: { settings: { unit: "metres", trim: false } } } })
    yield* applied("first")
    const key = yield* post("A", "settings that shape a tool " + plan([[
      call("measure", { value: 3 }), call("label", { label: "  bob  " }), call("plain", {}), mark("m1"), hold("h1"),
      call("measure", { value: 3 }), call("label", { label: "  bob  " }), call("plain", {}), mark("m2"), hold("h2"),
      call("measure", { value: 3 }), call("label", { label: "  bob  " }), call("plain", {}), mark("m3"), hold("h3"),
      call("measure", { value: 3 }), call("label", { label: "  bob  " }), call("plain", {})
    ]]))
    yield* marked("m1")
    settings({ plugins: { shaped: { settings: { unit: "feet", trim: false } } } })
    yield* applied("the unit setting, which is in a description")
    yield* release("h1")
    yield* marked("m2")
    settings({ plugins: { shaped: { settings: { unit: "feet", trim: true } } } })
    yield* applied("the trim setting, which is in a schema and not in a declaration")
    yield* release("h2")
    yield* marked("m3")
    settings({ plugins: { shaped: { settings: { unit: "feet", trim: true, min: 10 } } } })
    yield* applied("a minimum length, which is in a schema and not in a declaration")
    yield* release("h3")
    log("answer", { who: "A", key, text: (yield* ended(key))[0].text })
  }),

  // A result the Agent's schema no longer accepts: the limit on it was raised by a setting.
  "shape-result": Effect.gen(function*() {
    const { post, ended } = yield* setup
    write("shaped", shapedSource)
    settings({ plugins: { shaped: { settings: { max: 5 } } } })
    yield* applied("first")
    const key = yield* post("A", "a result that grew " + plan([[call("report", {}), mark("m1"), hold("h1"), call("report", {})]]))
    yield* marked("m1")
    settings({ plugins: { shaped: { settings: { max: 100 } } } })
    yield* applied("the limit on the result, which is in a schema and not in a declaration")
    yield* release("h1")
    log("answer", { who: "A", key, text: (yield* ended(key))[0].text })
  }),

  // A handler that ignores the interruption at the drain deadline. Run with short deadlines.
  stubborn: Effect.gen(function*() {
    const { post, ended } = yield* setup
    write("stubborn", stubbornSource("v1"))
    yield* applied("first")
    const key = yield* post("A", "a handler that cannot be interrupted " + plan([[call("stuck", { ms: 6000 })], [call("ping", {})]]))
    yield* until("stuck started", ev("plugin.stuck.start"))
    write("stubborn", stubbornSource("v2"))
    yield* applied("code change")
    log("answer", { who: "A", key, text: (yield* ended(key))[0].text })
    yield* until("the abandoned handler ended", ev("flight.endedAfterAbandon"), { timeout: 20_000 })
  }),

  // A background sub-agent the script does not wait for. clanka keeps the turn open while it runs.
  "bg-open": Effect.gen(function*() {
    const { post, ask, ended } = yield* setup
    write("echo", echoSource({ label: "v1" }))
    yield* applied("first")
    const child = "TASK-bg " + plan([[call("echo", { text: "bg1" }), mark("bg1"), hold("h1"), call("echo", { text: "bg2" }), mark("bg2"), hold("h2"), call("echo", { text: "bg3" })]], true) + "\n"
    const key = yield* post("A", "start it and answer " + plan([[
      "const bg = await subagent({ prompt: " + JSON.stringify(child) + ", background: true })",
      "console.log('started ' + bg.id + ' ' + bg.status)",
      mark("t1")
    ]]))
    yield* marked("bg1")
    yield* Effect.sleep(1500)
    log("bg.turnStillOpen", { open: !events().some((x) => x.ev === "turn.end" && x.key === key), modelAnswered: true })
    yield* reloaded({ names: ["echo"], reason: "chad plugin reload" })
    yield* release("h1")
    yield* marked("bg2")
    write("echo", echoSource({ label: "v2" }))
    yield* applied("code change")
    // The owner's next message does not start a turn: the host steers it into the one that is still open.
    yield* post("A", "try the new version " + plan([[call("echo", { text: "steered" }), mark("steered")]]))
    yield* marked("steered")
    yield* release("h2")
    log("answer", { who: "A", key, text: (yield* ended(key))[0].text })
    yield* ask("A", "the next turn " + plan([[call("echo", { text: "t2" })]]))
  }),

  // Why the routing rule is by bundle hash. With PROTO_ROUTE_ANY=1 the call goes to the new
  // version by tool name, decoded by the old Agent's schema.
  hole: Effect.gen(function*() {
    const { post, ended } = yield* setup
    write("conv", convSource(1))
    yield* applied("first")
    const key = yield* post("A", "a changed parameter " + plan([[call("store", { n: "42" }), mark("m1"), hold("h1"), call("store", { n: "42" })]]))
    yield* marked("m1")
    write("conv", convSource(2))
    yield* applied("NumberFromString became String")
    yield* release("h1")
    log("answer", { who: "A", key, text: (yield* ended(key))[0].text })
  })
}

const main = Effect.gen(function*() {
  log("scenario.start", { name, phase, drainMs: Plugins.DRAIN_MS, closeMs: Plugins.CLOSE_MS })
  yield* scenarios[name]
  log("scenario.end", { name, phase })
})

if (first) {
  rmSync(Plugins.REPO, { recursive: true, force: true })
  mkdirSync(Plugins.VERSIONS, { recursive: true })
  mkdirSync(plugins, { recursive: true })
}

main.pipe(Effect.provide(HostLive as Layer.Layer<any, any, never>), NodeRuntime.runMain)
