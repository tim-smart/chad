// PROTOTYPE for TIM-543. Throwaway. The driver: starts scenarios.ts as child
// processes, kills them at chosen events, restarts them and checks the event log.
//   node run.ts            every scenario
//   node run.ts steer stop only those
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const OUT = "out"
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Phase {
  readonly env?: Record<string, string>
  readonly killOn?: (e: any) => boolean
  readonly killDelay?: number
  readonly signal?: NodeJS.Signals
  readonly pauseAfter?: number
  readonly timeout?: number
}
interface Spec {
  readonly id: string
  readonly scenario: string
  readonly brain: "fake" | "real"
  readonly env?: Record<string, string>
  readonly phases: ReadonlyArray<Phase>
  readonly check: (E: Array<any>, c: (label: string, ok: boolean, detail?: unknown) => void) => void
}

const read = (file: string): Array<any> =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []

const results: Array<string> = []
const runSpec = async (spec: Spec) => {
  const logFile = OUT + "/" + spec.id + ".jsonl"
  for (const f of [logFile, OUT + "/" + spec.id + ".sqlite", OUT + "/" + spec.id + ".sqlite-wal", OUT + "/" + spec.id + ".sqlite-shm", OUT + "/" + spec.id + ".stdout"]) rmSync(f, { force: true })
  rmSync(OUT + "/work-" + spec.id, { recursive: true, force: true })
  const pids: Array<number> = []
  for (let i = 0; i < spec.phases.length; i++) {
    const phase = spec.phases[i]
    const fd = openSync(OUT + "/" + spec.id + ".stdout", "a")
    const child = spawn(process.execPath, ["scenarios.ts", spec.scenario, String(i + 1)], {
      env: { ...process.env, PROTO_DB: OUT + "/" + spec.id + ".sqlite", PROTO_LOG: logFile, PROTO_WORK: OUT + "/work-" + spec.id, PROTO_BRAIN: spec.brain, ...spec.env, ...phase.env },
      stdio: ["ignore", fd, fd]
    })
    pids.push(child.pid!)
    let exited = false
    const exit = new Promise<void>((resolve) => child.on("exit", (code, signal) => { exited = true; appendFileSync(logFile, JSON.stringify({ t: Date.now(), pid: child.pid, ev: "process.exit", code, signal }) + "\n"); resolve() }))
    const deadline = Date.now() + (phase.timeout ?? 240_000)
    let killing = false
    while (!exited) {
      await sleep(40)
      if (!killing && phase.killOn && read(logFile).some((e) => e.pid === child.pid && phase.killOn!(e))) {
        killing = true
        setTimeout(() => child.kill(phase.signal ?? "SIGKILL"), phase.killDelay ?? 0)
      }
      if (Date.now() > deadline) {
        appendFileSync(logFile, JSON.stringify({ t: Date.now(), pid: child.pid, ev: "driver.timeout" }) + "\n")
        child.kill("SIGKILL")
        break
      }
    }
    await exit
    if (phase.pauseAfter) await sleep(phase.pauseAfter)
  }
  const E = read(logFile).map((e) => ({ ...e, phase: pids.indexOf(e.pid) + 1 }))
  const check = (label: string, ok: boolean, detail?: unknown) => {
    const line = (ok ? "PASS" : "FAIL") + "  [" + spec.id + ", " + spec.brain + " brain]  " + label + (detail === undefined ? "" : "  (" + (typeof detail === "string" ? detail : JSON.stringify(detail)) + ")")
    results.push(line)
    console.log(line)
  }
  if (E.some((e) => e.ev === "driver.timeout" || e.ev === "scenario.timeout")) check("the scenario ran to its end", false, E.filter((e) => e.ev === "scenario.timeout").map((e) => e.label))
  try {
    spec.check(E, check)
  } catch (error) {
    check("the checks ran", false, String(error))
  }
}

const of = (E: Array<any>, ev: string, pred?: (e: any) => boolean) => E.filter((e) => e.ev === ev && (pred === undefined || pred(e)))
const bot = (E: Array<any>): Array<string> => of(E, "bot.messages").at(-1)?.messages ?? []
const timerKey = (e: any) => String(e.key).startsWith("timer/")

const chainSpec = (variant: "before" | "mid" | "after"): Spec => ({
  id: "chain-" + variant,
  scenario: "chain",
  brain: "fake",
  env: { PROTO_VARIANT: variant, PROTO_POLL: "1000" },
  phases: [
    variant === "before"
      ? { killOn: (e) => e.ev === "pluginTurn.delivered", killDelay: 300 }
      : variant === "mid"
      ? { killOn: (e) => e.ev === "turn.start" && timerKey(e), killDelay: 800 }
      : { env: { PROTO_PAUSE_BEFORE_NEXT: "3000" }, killOn: (e) => e.ev === "timer.pauseBeforeNext", killDelay: 300 },
    {}
  ],
  check: (E, c) => {
    const starts = of(E, "turn.start", timerKey)
    const perKey = new Map<string, Array<any>>()
    for (const s of starts) perKey.set(s.key, [...(perKey.get(s.key) ?? []), s])
    const keys = [...perKey.keys()]
    const firstKey = of(E, "pluginTurn.delivered", timerKey)[0]?.key
    const firstStarts = (perKey.get(firstKey) ?? []).map((s) => "phase " + s.phase + " start " + s.starts)
    if (variant === "before") c("killed while the timer's turn waited behind the owner's turn: the turn then starts once", firstStarts.length === 1 && firstStarts[0] === "phase 2 start 1", firstStarts)
    if (variant === "mid") c("killed mid-turn: the same scheduled time is resumed once, not started as a second turn", firstStarts.length === 2 && firstStarts[1] === "phase 2 start 2", firstStarts)
    if (variant === "after") {
      c("killed between the turn ending and the next run being saved: no second turn for that time", firstStarts.length === 1 && firstStarts[0] === "phase 1 start 1", firstStarts)
      c("the redelivered timer got the stored outcome and saved the next run", of(E, "timer.nextSaved", (e) => e.phase === 2 && String(firstKey).endsWith("/" + e.at)).length === 1)
    }
    c("the chain went on after the restart", of(E, "timer.nextSaved", (e) => e.phase === 2).length >= 2, of(E, "timer.nextSaved").map((e) => "phase " + e.phase))
    c("every later scheduled time started exactly one turn", keys.filter((k) => k !== firstKey).every((k) => perKey.get(k)!.length === 1), keys.map((k) => perKey.get(k)!.length))
  }
})

const specs: Array<Spec> = [
  {
    id: "latency", scenario: "latency", brain: "fake", phases: [{}],
    check: (E, c) => {
      const ms = [...of(E, "message.delivered"), ...of(E, "pluginTurn.delivered")].map((e) => e.ms)
      c("a persisted message reaches the local entity straight after the save, not on the 10s poll", ms.length === 4 && ms.every((m) => m < 1000), { coldMs: ms[0], warmMs: ms.slice(1, 3), pluginTurnMs: ms[3] })
    }
  },
  {
    id: "steer", scenario: "steer", brain: "real", phases: [{ timeout: 420_000 }],
    check: (E, c) => {
      const answers = bot(E)
      c("a message sent during a turn steers it", of(E, "message.steered").length >= 1 && /ALPHA/.test(answers[0] ?? "") && /BRAVO/.test(answers[0] ?? ""), answers[0])
      const lates = of(E, "late.posted")
      const fates = lates.map((l) => ({ afterScriptOutputMs: l.offset, fate: of(E, "message.steered", (e) => e.key === l.key).length ? "steered" : of(E, "turn.start", (e) => e.key === l.key).length ? "next turn" : "lost" }))
      c("a message that lands near the end of a turn either joins it or becomes the next turn", fates.length === 5 && fates.every((f) => f.fate !== "lost"), fates)
      c("each of those messages is in the stored history exactly once", of(E, "late.inHistory").every((e) => e.copies === 1), of(E, "late.inHistory").map((e) => e.copies))
      const stats = of(E, "steer.stats")[0] ?? {}
      c("never two sends at once, and one send per turn", stats.maxActiveSends === 1 && stats.sends === stats.turnsEnded, stats)
      c("no turn failed", of(E, "turn.brainFailed").length === 0)
    }
  },
  {
    id: "kill-resume", scenario: "kill-resume", brain: "real",
    phases: [{ killOn: (e) => e.ev === "brain.scriptEnd", killDelay: 3000 }, { timeout: 240_000 }],
    check: (E, c) => {
      const p2 = E.filter((e) => e.phase === 2)
      const delivered = of(p2, "message.delivered")[0]
      const boot = of(p2, "scenario.start")[0]
      c("after a kill mid-turn the message is redelivered with no new post", of(p2, "user.posted").length === 0 && delivered !== undefined, delivered && { msAfterStart: delivered.t - boot.t })
      const start = of(p2, "turn.start")[0]
      c("the turn resumes once, as the second start of the same request", start?.starts === 2 && start?.resumed === true)
      const before = of(E, "hook.beforeTurn")
      c("beforeTurn runs again for the resumed turn, with the first attempt's id and origin, resumed true and the restart note as the prompt",
        before.length === 2 && before[0].turn === before[1].turn && JSON.stringify(before[0].origin) === JSON.stringify(before[1].origin) && before[0].resumed === false && before[1].resumed === true && String(before[1].prompt).startsWith("[chad restarted"),
        before.map((b) => ({ phase: b.phase, resumed: b.resumed, prompt: b.prompt })))
      const after = of(E, "hook.afterTurn")
      c("afterTurn runs once, for the attempt that finished", after.length === 1 && after[0].phase === 2 && after[0].turn === before[0]?.turn && after[0].resumed === true, after.map((a) => ({ phase: a.phase, outcome: a.outcome, resumed: a.resumed })))
      c("the history stored up to the kill loads into a new Agent and the model answers", of(p2, "session.restored").length === 1 && of(p2, "turn.end")[0]?.outcome === "Answered" && of(E, "turn.brainFailed").length === 0, { restored: of(p2, "session.restored")[0]?.messages, answer: bot(E).at(-1) })
    }
  },
  {
    id: "kill-twice", scenario: "kill-twice", brain: "fake",
    phases: [{ killOn: (e) => e.ev === "turn.start", killDelay: 500 }, { killOn: (e) => e.ev === "turn.start", killDelay: 500 }, {}],
    check: (E, c) => {
      const starts = of(E, "turn.start").map((s) => "phase " + s.phase + " start " + s.starts)
      c("chad counts the starts of one request in its own turns row", starts.join(", ") === "phase 1 start 1, phase 2 start 2, phase 3 start 3", starts)
      const end = of(E, "turn.end")
      c("the second redelivery is not resumed: the turn ends as Failed and chad says it was cut off", end.length === 1 && end[0].outcome === "Failed" && /cut off/.test(bot(E).join(" ")), bot(E))
      const before = of(E, "hook.beforeTurn"), after = of(E, "hook.afterTurn")
      c("beforeTurn ran for the first start and the resume, not for the give-up", before.length === 2 && before.map((b) => b.phase).join() === "1,2")
      c("afterTurn runs once, with Failed, the first attempt's id and resumed true", after.length === 1 && after[0].outcome === "Failed" && after[0].reason === "Interrupted" && after[0].turn === before[0]?.turn && after[0].resumed === true, after.map((a) => ({ outcome: a.outcome, reason: a.reason, resumed: a.resumed })))
    }
  },
  {
    id: "term-mid-turn", scenario: "term-mid-turn", brain: "fake",
    phases: [{ killOn: (e) => e.ev === "turn.start", killDelay: 1000, signal: "SIGTERM" }, {}],
    check: (E, c) => {
      const p1 = E.filter((e) => e.phase === 1), p2 = E.filter((e) => e.phase === 2)
      c("a graceful stop mid-turn leaves the request unprocessed", of(p1, "turn.end").length === 0 && of(p1, "process.exit").length === 1, of(p1, "process.exit")[0])
      c("the next start redelivers it, and it counts as the one resume", of(p2, "turn.start")[0]?.starts === 2 && of(p2, "turn.end")[0]?.outcome === "Answered", of(p2, "turn.start").map((s) => s.starts))
    }
  },
  {
    id: "term-then-kill", scenario: "term-then-kill", brain: "fake", env: { PROTO_GRACEFUL_FREE: "1" },
    phases: [
      { killOn: (e) => e.ev === "turn.start", killDelay: 1000, signal: "SIGTERM" },
      { killOn: (e) => e.ev === "turn.start", killDelay: 1000, signal: "SIGTERM" },
      { killOn: (e) => e.ev === "turn.start", killDelay: 500 },
      { killOn: (e) => e.ev === "turn.start", killDelay: 500 },
      {}
    ],
    check: (E, c) => {
      const cuts = of(E, "turn.cutByShutdown")
      c("a graceful stop that cuts a turn records the cut in the turns row before the process exits", cuts.length === 2 && cuts.every((x) => x.saved) && cuts.map((x) => x.phase).join() === "1,2", cuts.map((x) => ({ phase: x.phase, saved: x.saved })))
      const starts = of(E, "turn.start").map((s) => "phase " + s.phase + ": start " + s.starts + ", " + s.kills + " kills")
      c("two graceful stops do not spend the resume: the turn is still resumed after them, and again after the first kill", starts.join("; ") === "phase 1: start 1, 0 kills; phase 2: start 2, 0 kills; phase 3: start 3, 0 kills; phase 4: start 4, 1 kills; phase 5: start 5, 2 kills" && of(E, "hook.beforeTurn").map((b) => b.phase).join() === "1,2,3,4", starts)
      c("every resumed start gets the restart note and resumed true", of(E, "hook.beforeTurn").slice(1).every((b) => b.resumed === true && String(b.prompt).startsWith("[chad restarted")))
      const end = of(E, "turn.end"), after = of(E, "hook.afterTurn")
      c("the second kill still makes chad give up, with afterTurn once as Failed", end.length === 1 && end[0].phase === 5 && end[0].outcome === "Failed" && after.length === 1 && after[0].outcome === "Failed", bot(E))
    }
  },
  ...[10_000, 1000].map((poll): Spec => ({
    id: "idle-cost-poll" + poll / 1000 + "s", scenario: "idle-cost", brain: "fake", env: { PROTO_POLL: String(poll) }, phases: [{}],
    check: (E, c) => {
      const cpu = of(E, "idle.cpu")[0]
      c("an idle chad with a " + poll / 1000 + "s storage poll uses little CPU", cpu !== undefined && cpu.cpuMs < cpu.wallMs * 0.05, cpu && { cpuMsOver30s: cpu.cpuMs, percentOfOneCore: Math.round(cpu.cpuMs / cpu.wallMs * 1000) / 10 })
    }
  })),
  {
    id: "term-short", scenario: "term-mid-turn", brain: "fake", env: { PROTO_VARIANT: "short" },
    phases: [{ killOn: (e) => e.ev === "turn.start", killDelay: 1000, signal: "SIGTERM" }, {}],
    check: (E, c) => {
      const p1 = E.filter((e) => e.phase === 1), p2 = E.filter((e) => e.phase === 2)
      const start = of(p1, "turn.start")[0], end = of(p1, "turn.end")[0], exit = of(p1, "process.exit")[0]
      c("a graceful stop lets a turn that ends inside cluster's 15s termination timeout finish", end?.outcome === "Answered", { sigtermAtMs: 1000, turnEndedAtMs: end && end.t - start.t, exitedAtMs: exit && exit.t - start.t })
      c("that turn is not redelivered on the next start", of(p2, "message.delivered").length === 0)
    }
  },
  ...(["short", "inturn", "own"] as const).map((variant): Spec => ({
    id: "compact-real-" + variant, scenario: "compact-real", brain: "real",
    env: { PROTO_VARIANT: variant, PROTO_COMPACT_THRESHOLD: "3000", PROTO_COMPACT_KEEP: "300", ...(variant === "own" ? { PROTO_SUMMARIZER: "1" } : {}) },
    phases: [{ timeout: 300_000 }],
    check: (E, c) => {
      const marks = of(E, "mark")
      const turnOf = (e: any) => marks.filter((m) => m.t <= e.t).length
      const started = of(E, "brain.CompactionStarted").map(turnOf)
      const ended = of(E, "brain.CompactionEnded").map((e) => "turn " + turnOf(e) + " " + e.tokensBefore + ">" + e.tokensAfter)
      const replaced = of(E, "brain.historyReplaced").map(turnOf)
      const compactedTurns = of(E, "turn.end", (e) => e.compacted).map(turnOf)
      const detail = { startedInTurn: started, ended, historyReplacedInTurn: replaced, turnsChadSawCompact: compactedTurns, historyRows: of(E, "history.rows")[0]?.rows }
      if (variant === "short") {
        const cancelled = of(E, "brain.CompactionEnded", (e) => e.tokensBefore === e.tokensAfter).length
        const endedIn = of(E, "brain.CompactionEnded").map(turnOf)
        c("short turns on the agent's own model: every summarizer call ends in the turn that started it, applied if it beat the turn's end and cancelled if not", started.length >= 1 && started.join() === endedIn.join(), { ...detail, summarizerCallsStarted: started.length, cancelledAtTurnEnd: cancelled, applied: replaced.length })
      } else {
        c(variant === "inturn"
          ? "a summarizer that finishes inside a long turn: HistoryReplaced arrives on that turn's stream"
          : "a summarizer on its own model: it outlives the turn that started it and HistoryReplaced arrives on a later turn's stream",
          replaced.length >= 1 && compactedTurns.length >= 1 && (variant === "inturn" ? replaced[0] === started[0] : replaced[0] > started[0]), detail)
        const waited = of(E, "turn.waitedForHooks")
        c("the turn after the one that saw HistoryReplaced waited for the Compacted hook", waited.length >= 1 && of(E, "hook.compacted").length >= 1, waited.map((w) => w.ms + "ms"))
      }
      c("no turn failed and the last answer came", of(E, "turn.brainFailed").length === 0 && /LAST/.test(bot(E).at(-1) ?? ""), bot(E))
    }
  })),
  {
    id: "passivate", scenario: "passivate", brain: "real", env: { PROTO_IDLE: "6000" }, phases: [{ timeout: 300_000 }],
    check: (E, c) => {
      const peeks = of(E, "peek")
      c("the session passivates when idle and the next message restores it from SQLite", of(E, "session.passivated").length >= 1 && of(E, "session.restored").length === 1 && peeks[0]?.activation !== peeks[1]?.activation, { activations: peeks.map((p) => p.activation), restoredMessages: of(E, "session.restored")[0]?.messages })
      c("the restored session remembers the conversation", /HERON-42/.test(bot(E)[3] ?? ""), bot(E))
      c("the restored session sends the same frozen system prompt", peeks.length === 2 && peeks[0].system === peeks[1].system && peeks[0].systemChars > 0, peeks.map((p) => p.system + " " + p.systemChars + " chars"))
      const usage = of(E, "turn.usage").map((u) => u.calls[0])
      const cached = (s: string) => Number(/ (\d+) cached/.exec(s)?.[1] ?? -1)
      c("the first call after the restore reads the cache like a call inside one activation does", cached(usage[3] ?? "") > 0 && cached(usage[3]) >= cached(usage[2] ?? "") * 0.9, { turnsBeforePassivation: usage.slice(0, 3), turnsAfterRestore: usage.slice(3) })
    }
  },
  {
    id: "idle", scenario: "idle", brain: "fake", env: { PROTO_IDLE: "3000" }, phases: [{}],
    check: (E, c) => {
      const end = of(E, "turn.end")[0], on = of(E, "keepAlive.on")[0], off = of(E, "keepAlive.off")[0]
      const passivated = of(E, "session.passivated", (e) => e.t < (of(E, "scenario.end")[0]?.t ?? Infinity))
      c("a 7s turn is not passivated by a 3s idle time", passivated.every((p) => p.t > end.t), passivated.map((p) => p.t - end.t))
      c("keepAlive holds the entity for 9s past a 3s idle time", passivated.every((p) => !(p.t > on.t && p.t < off.t)) && off.t - on.t >= 9000)
      c("it passivates once keepAlive is off", passivated.length === 1 && passivated[0].t >= off.t, passivated.map((p) => ({ msAfterKeepAliveOff: p.t - off.t })))
    }
  },
  {
    id: "stop", scenario: "stop", brain: "real", env: { PROTO_IDLE: "6000" }, phases: [{ timeout: 420_000 }],
    check: (E, c) => {
      const ends = of(E, "turn.end")
      const stops = of(E, "stop.received")
      c("/stop interrupts the running turn, which ends as Stopped", stops[0]?.by === "command" && ends[0]?.outcome === "Stopped", { msToTurnEnd: ends[0] && stops[0] ? ends[0].t - stops[0].t : null })
      c("a message waiting to steer the stopped turn is dropped", of(E, "message.dropped").length === 1 && of(E, "message.steered").length === 0)
      c("the history of the stopped turn loads into a new Agent, which answers", of(E, "session.restored").length === 1 && ends[1]?.outcome === "Answered" && of(E, "turn.brainFailed").length === 0, { restoredMessages: of(E, "session.restored")[0]?.messages, answer: bot(E)[1] })
      const reply = of(E, "button.reply")[0], button = of(E, "button.stop")[0]
      c("a click on the Stop button is acknowledged inside the 3s interaction deadline", reply?.reply === "Ack" && reply.ms < 3000, { reply: reply?.reply, ms: reply?.ms, entityCallMs: button?.ms })
      c("the click stops the turn the same way", stops[1]?.by === "button" && ends[2]?.outcome === "Stopped")
      c("the same Agent takes the next turn after an interrupted one", ends[3]?.outcome === "Answered" && /ALIVE/.test(bot(E).join(" ")))
      c("/stop with nothing running says so", /Nothing is running/.test(bot(E).at(-1) ?? ""), bot(E))
    }
  },
  {
    id: "button", scenario: "button", brain: "fake", phases: [{}],
    check: (E, c) => {
      const reply = of(E, "button.reply")[0]
      c("the Stop button's click reaches the entity and is acknowledged", reply?.reply === "Ack" && of(E, "turn.end")[0]?.outcome === "Stopped", { ms: reply?.ms })
    }
  },
  {
    id: "dedupe", scenario: "dedupe", brain: "fake", env: { PROTO_RETENTION: "3000" }, phases: [{}],
    check: (E, c) => {
      c("the same chat event delivered again is dropped by its primary key while cluster still has the request", of(E, "dedupe.afterSecond")[0]?.delivered === 1)
      c("once MessageRetention has pruned the request, cluster delivers the same event again", of(E, "dedupe.afterThird")[0]?.delivered === 2)
      c("chad's own turns row stops that from starting a second turn", of(E, "turn.start").length === 1 && of(E, "message.alreadyEnded").length === 1, { turnStarts: of(E, "turn.start").length })
    }
  },
  {
    id: "timer-held-term", scenario: "timer-held", brain: "fake",
    phases: [{ killOn: (e) => e.ev === "timer.held", killDelay: 500, signal: "SIGTERM" }, {}],
    check: (E, c) => {
      const held = of(E, "timer.held", (e) => e.phase === 1)[0], exit = of(E, "process.exit", (e) => e.phase === 1)[0]
      c("a graceful stop with a timer on hold waits out cluster's 15s termination timeout before the process exits", exit !== undefined && exit.t - held.t > 14_000, { msFromSigtermToExit: exit && exit.t - held.t - 500 })
      c("the held timer still fires once after the restart", of(E, "turn.start", (e) => e.phase === 2 && String(e.key).includes("/held/")).length === 1)
    }
  },
  {
    id: "defect", scenario: "defect", brain: "fake", phases: [{}, {}],
    check: (E, c) => {
      const p1 = E.filter((e) => e.phase === 1), p2 = E.filter((e) => e.phase === 2)
      const exit = of(p1, "defect.exit")[0]?.exit ?? ""
      c("a handler defect fails that one request", /Die|defect|boom/.test(exit), exit.slice(0, 160))
      const end = of(p1, "scenario.end")[0]
      c("the entity is not restarted: same activation, next message handled", of(p1, "session.activated").length === 1 && of(p1, "session.passivated", (e) => e.t < end.t).length === 0 && of(p1, "peek")[0]?.activation === 1 && of(p1, "turn.end").length === 2)
      c("the failed request is not redelivered after a restart", of(p2, "message.delivered").length === 0, of(E, "message.delivered").map((m) => "phase " + m.phase + " " + m.key))
    }
  },
  ...[10_000, 1000].map((poll): Spec => ({
    id: "timer-basic-poll" + poll / 1000 + "s", scenario: "timer-basic", brain: "fake", env: { PROTO_POLL: String(poll) },
    phases: [{ killOn: (e) => e.ev === "turns.scheduled" && e.timer === "cron/later", killDelay: 200, pauseAfter: 7000 }, {}],
    check: (E, c) => {
      const soon = of(E, "timer.delivered", (e) => e.timer === "cron/soon"), later = of(E, "timer.delivered", (e) => e.timer === "cron/later")
      c("a persisted message with DeliverAt is delivered within one storage poll (" + poll / 1000 + "s) of its time", soon.length === 1 && soon[0].lateMs >= 0 && soon[0].lateMs < poll + 500, { lateMs: soon[0]?.lateMs })
      c("a run that is overdue when the process starts is delivered once", later.length === 1 && later[0].phase === 2 && later[0].lateMs > 2000 && of(E, "turn.start", (e) => String(e.key).includes("/later/")).length === 1, { lateMs: later[0]?.lateMs, deliveries: later.length, msAfterProcessStart: later[0] && later[0].t - of(E, "scenario.start", (e) => e.phase === 2)[0].t })
    }
  })),
  {
    id: "timer-cancel", scenario: "timer-cancel", brain: "fake", phases: [{}],
    check: (E, c) => {
      const before = of(E, "rows.beforeCancel")[0], after = of(E, "rows.afterCancel")[0]
      c("clearAddress on the timer's address cancels the pending run", of(E, "timer.delivered").length === 0 && before?.timer === 1 && after?.timer === 0, { before, after })
      c("the Session entity's messages are left alone, and its queued plugin turn still runs", before?.session === after?.session && of(E, "turn.end", (e) => String(e.key).startsWith("start/")).length === 1)
    }
  },
  {
    id: "timer-cancel-run", scenario: "timer-cancel-run", brain: "fake", phases: [{}],
    check: (E, c) => {
      c("a cancel that lands during a run stays cancelled: the handler saves no next run", of(E, "timer.cancelledDuringRun").length === 1 && of(E, "timer.nextSaved").length === 0 && of(E, "turn.start").length === 1 && of(E, "timer.delivered").length === 1, { deliveries: of(E, "timer.delivered").length, turns: of(E, "turn.start").length })
      c("the run that had started still finished", of(E, "turn.end")[0]?.outcome === "Answered")
    }
  },
  chainSpec("before"),
  chainSpec("mid"),
  chainSpec("after"),
  {
    id: "timer-held", scenario: "timer-held", brain: "fake",
    phases: [{ killOn: (e) => e.ev === "timer.held", killDelay: 500 }, {}],
    check: (E, c) => {
      const p2 = E.filter((e) => e.phase === 2)
      c("a timer whose plugin is not loaded is held: delivered, no turn", of(E, "timer.held", (e) => e.phase === 1).length === 2 && of(E, "turn.start", (e) => e.phase === 1).length === 0)
      c("the hold survives a kill: the request is redelivered and held again", of(p2, "timer.held").length === 2)
      const loaded = of(p2, "plugin.loaded")[0]
      const starts = of(p2, "turn.start")
      c("it fires once when the plugin comes back", starts.length === 1 && String(starts[0].key).includes("/held/") && starts[0].t >= loaded.t, { msAfterLoad: starts[0] && loaded ? starts[0].t - loaded.t : null })
      c("a held timer that was cancelled meanwhile does not fire", of(p2, "turn.start", (e) => String(e.key).includes("/held2/")).length === 0)
    }
  },
  {
    id: "timer-prune", scenario: "timer-prune", brain: "fake", env: { PROTO_RETENTION: "2000", PROTO_POLL: "1000" }, phases: [{}],
    check: (E, c) => {
      const rows = of(E, "prune.rows")
      const starts = of(E, "turn.start", timerKey)
      const runs = new Set(starts.map((s) => s.key)).size
      c("with MessageRetention on the Timer entity the chain keeps running, one turn per scheduled time", runs >= 5 && runs === starts.length, { runs, turnStarts: starts.length })
      c("completed timer requests are pruned", Math.max(...rows.map((r) => r.timerProcessed)) <= 2, rows.map((r) => r.timerProcessed + " done/" + r.timerPending + " pending"))
    }
  },
  {
    id: "tool-queue", scenario: "tool-queue", brain: "real", phases: [{ timeout: 240_000 }],
    check: (E, c) => {
      const returned = of(E, "tool.queueTurn.returned")[0]
      const ends = of(E, "turn.end"), starts = of(E, "turn.start")
      c("a tool that starts a turn for its own thread returns without waiting", returned !== undefined && returned.t < ends[0]?.t, { toolReturnedMs: returned?.ms })
      c("the queued turn runs after the calling turn ends", starts.length === 2 && String(starts[1].key).startsWith("start/") && starts[1].t >= ends[0].t && ends[1]?.outcome === "Answered", bot(E))
    }
  },
  {
    id: "compact-gate-slow", scenario: "compact-gate", brain: "fake", phases: [{}],
    check: (E, c) => {
      const waited = of(E, "turn.waitedForHooks")[0]
      c("after a turn that compacted, the next turn waits for that turn's afterTurn and Compacted hooks", waited !== undefined && of(E, "turn.end").length === 2, { waitedMs: waited?.ms, hooks: of(E, "hook.done").map((h) => h.plugin + " " + h.label + " " + h.result + " " + h.ms + "ms") })
      c("with one plugin whose calls hang, the wait is the two budgets added up (30s + 10s)", waited?.ms > 39_000 && waited?.ms < 42_000, { waitedMs: waited?.ms })
      c("the message that arrived in the meantime is not lost", /arrived in the meantime/.test(bot(E).join(" ")))
    }
  },
  {
    id: "compact-gate-fast", scenario: "compact-gate", brain: "fake", env: { PROTO_VARIANT: "fast" }, phases: [{}],
    check: (E, c) => {
      const waited = of(E, "turn.waitedForHooks")[0]
      c("with hooks that return, the wait is the hooks' own time", waited?.ms < 1000, { waitedMs: waited?.ms })
    }
  },
  {
    id: "graceful-term", scenario: "graceful", brain: "fake", phases: [{ killOn: (e) => e.ev === "turn.end", killDelay: 150, signal: "SIGTERM" }],
    check: (E, c) => {
      const order = E.filter((e) => ["hooks.draining", "hook.afterTurn.finished", "hook.done", "hooks.drained", "plugins.closed"].includes(e.ev)).map((e) => e.ev)
      c("on a graceful stop a queued afterTurn finishes before the plugins' scopes close", order.join(" > ") === "hooks.draining > hook.afterTurn.finished > hook.done > hooks.drained > plugins.closed", order)
    }
  },
  {
    id: "graceful-kill", scenario: "graceful", brain: "fake", phases: [{ killOn: (e) => e.ev === "turn.end", killDelay: 150 }],
    check: (E, c) => c("on a kill the queued hook is lost", of(E, "hook.afterTurn.finished").length === 0 && of(E, "hooks.draining").length === 0)
  },
  {
    id: "chunks", scenario: "chunks", brain: "fake", phases: [{}],
    check: (E, c) => {
      const updates = of(E, "chunk.updateSent").map((u) => u.text.split("\n").at(-1))
      const failed = of(E, "chunk.renderFailed")
      c("a chunk whose render fails keeps the text the session last saw", failed.length === 1 && failed[0].kept === "memory block v2")
      c("no update message is sent for the failed render or for the unchanged text after it", updates.join(" | ") === "memory block v2 | memory block v3" && of(E, "chunks.updatesInHistory")[0]?.rows === 2, updates)
    }
  }
]

const wanted = process.argv.slice(2)
const chosen = specs.filter((s) => wanted.length === 0 || wanted.includes(s.id))
// A few at a time. Each has its own SQLite file and log.
const queue = [...chosen]
await Promise.all(Array.from({ length: Number(process.env.PROTO_PARALLEL ?? 5) }, async () => {
  while (queue.length > 0) await runSpec(queue.shift()!)
}))
const failed = results.filter((r) => r.startsWith("FAIL")).length
console.log("\n" + results.length + " checks, " + failed + " failed")
if (wanted.length === 0) writeFileSync(OUT + "/results.txt", results.sort((a, b) => a.slice(6).localeCompare(b.slice(6))).join("\n") + "\n\n" + results.length + " checks, " + failed + " failed\n")
