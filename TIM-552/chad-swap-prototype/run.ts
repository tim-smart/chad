// PROTOTYPE for "The plugin swap run with live sessions" (TIM-552). Throwaway.
// The driver: starts scenarios.ts as child processes, sends SIGTERM at chosen events, restarts
// them on the same SQLite file and plugin repo, and checks the event log.
//   node run.ts              every scenario
//   node run.ts gate hooks   only those
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const OUT = "out"
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Phase {
  readonly env?: Record<string, string>
  /** Given this process's events so far. SIGTERM is sent once it returns true. */
  readonly stopOn?: (events: Array<any>) => boolean
  readonly stopDelay?: number
}
type Check = (label: string, ok: boolean, detail?: unknown) => void
interface Spec {
  readonly id: string
  readonly scenario: string
  readonly claim: string
  readonly env?: Record<string, string>
  readonly phases?: ReadonlyArray<Phase>
  readonly check: (E: Array<any>, c: Check, answers: Array<string>) => void
}

const read = (file: string): Array<any> =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []

const results: Array<string> = []
const runSpec = async (spec: Spec) => {
  const logFile = OUT + "/" + spec.id + ".jsonl"
  for (const f of [logFile, OUT + "/" + spec.id + ".sqlite", OUT + "/" + spec.id + ".sqlite-wal", OUT + "/" + spec.id + ".sqlite-shm", OUT + "/" + spec.id + ".stdout"]) rmSync(f, { force: true })
  rmSync(OUT + "/work-" + spec.id, { recursive: true, force: true })
  const pids: Array<number> = []
  const phases = spec.phases ?? [{}]
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]
    const fd = openSync(OUT + "/" + spec.id + ".stdout", "a")
    const child = spawn(process.execPath, ["scenarios.ts", spec.scenario, String(i + 1)], {
      env: { ...process.env, PROTO_DB: OUT + "/" + spec.id + ".sqlite", PROTO_LOG: logFile, PROTO_WORK: OUT + "/work-" + spec.id, PROTO_REPO: OUT + "/repo-" + spec.id, ...spec.env, ...phase.env },
      stdio: ["ignore", fd, fd]
    })
    pids.push(child.pid!)
    let exited = false
    const exit = new Promise<void>((resolve) =>
      child.on("exit", (code, signal) => {
        exited = true
        appendFileSync(logFile, JSON.stringify({ t: Date.now(), pid: child.pid, ev: "process.exit", code, signal }) + "\n")
        resolve()
      })
    )
    const deadline = Date.now() + 180_000
    let stopping = false
    while (!exited) {
      await sleep(25)
      if (!stopping && phase.stopOn && phase.stopOn(read(logFile).filter((e) => e.pid === child.pid))) {
        stopping = true
        setTimeout(() => {
          appendFileSync(logFile, JSON.stringify({ t: Date.now(), pid: child.pid, ev: "driver.sigterm" }) + "\n")
          child.kill("SIGTERM")
        }, phase.stopDelay ?? 0)
      }
      if (Date.now() > deadline) {
        appendFileSync(logFile, JSON.stringify({ t: Date.now(), pid: child.pid, ev: "driver.timeout" }) + "\n")
        child.kill("SIGKILL")
        break
      }
    }
    await exit
  }
  const E = read(logFile).map((e) => ({ ...e, phase: pids.indexOf(e.pid) + 1 }))
  const check: Check = (label, ok, detail) => {
    const line = (ok ? "PASS" : "FAIL") + "  [" + spec.id + "]  " + label + (detail === undefined ? "" : "  (" + (typeof detail === "string" ? detail : JSON.stringify(detail)) + ")")
    results.push(line)
    console.log(line)
  }
  results.push("", "## " + spec.id + ": " + spec.claim)
  console.log("\n## " + spec.id + ": " + spec.claim)
  if (E.some((e) => e.ev === "driver.timeout" || e.ev === "scenario.timeout")) check("the scenario ran to its end", false, E.filter((e) => e.ev === "scenario.timeout").map((e) => e.label))
  const dead = E.filter((e) => JSON.stringify(e).includes("USED AFTER CLOSE"))
  check("no handler touched what a closed version owned", dead.length === 0, dead.length === 0 ? undefined : dead.length + " events")
  check("no turn failed", !E.some((e) => e.ev === "turn.brainFailed"))
  try {
    spec.check(E, check, E.filter((e) => e.ev === "answer").map((e) => results_(String(e.text))))
  } catch (error) {
    check("the checks ran", false, String(error))
  }
}

/** An answer is RESULTS and a JSON array of each script's output. Joined here, so a check reads what the script printed. */
const results_ = (text: string): string => {
  try {
    return (JSON.parse(text.slice(text.indexOf("[")) ) as Array<string>).join("")
  } catch {
    return text
  }
}
const of = (E: Array<any>, ev: string, pred?: (e: any) => boolean) => E.filter((e) => e.ev === ev && (pred === undefined || pred(e)))
const CHANGED = "was changed by an apply. The new version is in your next turn."
const CHANGED_SUB = "was changed by an apply. The new version is in your next turn, which cannot start while this turn has a sub-agent running."
const within = (value: number, low: number, high: number) => value >= low && value <= high
const stopBudget = (E: Array<any>, c: Check) => {
  const term = of(E, "driver.sigterm")[0]
  const exit = of(E, "process.exit", (e) => e.phase === 1)[0]
  c("the process exited by itself after SIGTERM", term !== undefined && exit !== undefined && exit.signal === null, { ms: exit && term ? exit.t - term.t : null, code: exit?.code })
}

const specs: Array<Spec> = [
  {
    id: "route",
    scenario: "route",
    claim: "the wrapper looks the version up per call; a reload that keeps the code reaches a running turn",
    check: (E, c, answers) => {
      const routed = of(E, "call.routed")
      c("one turn, one Agent, four calls routed to four instances of the same bundle", of(E, "agent.built").length === 1 && routed.length === 4 && new Set(routed.map((e) => e.to)).size === 4 && new Set(routed.map((e) => e.built)).size === 1, routed.map((e) => e.to))
      c("after chad plugin reload the running turn's call is answered by the new instance", answers[0].includes("v1 hi Pacific/Auckland #2: b"))
      c("after a timezone change it is answered by an instance built with the new timezone", answers[0].includes("v1 hi Europe/London #3: c"))
      c("after an apply that changed only a setting it is answered with the new setting", answers[0].includes("v1 yo Europe/London #4: d"))
    }
  },
  {
    id: "changed",
    scenario: "changed",
    claim: "after an apply that changed the code a running turn's call fails with the agreed message and the turn carries on; the same for a removed tool and safe mode",
    check: (E, c, answers) => {
      c("the running turn's next call fails with the agreed message", answers[0].includes("ERR echo " + CHANGED), answers[0].slice(0, 200))
      c("a tool of the same plugin whose own code did not change fails too (the rule is per bundle)", answers[0].includes("ERR slow " + CHANGED))
      c("the turn carries on and ends with an answer", answers[0].includes("the turn carried on") && of(E, "turn.end")[0]?.outcome === "Answered")
      c("a turn in another session loses the tool as well", answers[1].includes("ERR echo " + CHANGED))
      const apply = of(E, "cli.apply", (e) => e.label === "code change")[0]
      c("the apply output names both sessions with a running turn", apply.swap.affected.length === 2, apply.swap.affected)
      c("the next turn has the new version", answers[2].includes("OK \"v2 hi"))
      c("a tool the apply removed fails with the removed message", answers[3].includes("ERR slow was removed by an apply and is gone from your next turn."))
      c("in safe mode the call fails with the safe mode message", answers[4].includes("ERR echo is off in safe mode."))
      const held = of(E, "timer.held")[0]
      c("a timer of a plugin that safe mode turned off is held, and runs after safe off", of(E, "safe.stillOn")[0]?.timerTurnStarted === false && held?.why === "held, not loaded" && /OK "v3 hi .* timer/.test(answers[5]), held)
      c("after safe off the next turn has the plugin again", answers[6].includes("OK \"v3 hi"))
    }
  },
  {
    id: "gate",
    scenario: "gate",
    claim: "a call that arrives during a swap is held for the activation and not cut off; one from an Agent built on another bundle fails at once",
    check: (E, c, answers) => {
      const closed = of(E, "swap.gateClosed", (e) => e.label.startsWith("reload"))[0]
      const activated = of(E, "swap.activated", (e) => e.label.startsWith("reload"))[0]
      c("the call in flight when the gate closed finished on the old instance, and the swap waited for it", answers[0].includes("#2: slow a") && within(activated.waitedMs, 2000, 3500) && activated.interrupted.length === 0, { waitedMs: activated.waitedMs })
      const held = of(E, "call.held")[0]
      const released = of(E, "call.released")[0]
      c("a call from an Agent built on this bundle was held at the gate", held !== undefined && held.t >= closed.t && held.t < activated.t, { heldMs: released?.heldMs })
      c("it was released at the activation and answered by the new instance", released !== undefined && released.t >= activated.t - 5 && answers[1].includes("#3: b-during-swap"), answers[1])
      const refused = of(E, "call.refused")[0]
      c("a call from an Agent built on another bundle failed at once, at the closed gate", refused?.at === "closed gate" && refused.t < activated.t && refused.t - closed.t < 1500 && answers[2].includes("ERR echo " + CHANGED), { msAfterGateClosed: refused ? refused.t - closed.t : null })
    }
  },
  {
    id: "deadlines",
    scenario: "deadlines",
    claim: "the real constants: a 30 s drain, a 10 s close, a 40 s wait for a turn, a timer held for the activation",
    check: (E, c, answers) => {
      const activated = of(E, "swap.activated", (e) => e.label === "apply")[1]
      c("the drain took 30 seconds", within(activated.drainedMs, 29_900, 30_600), { drainedMs: activated.drainedMs })
      const cut = of(E, "call.interruptedBySwap")[0]
      c("the tool call still running then was interrupted with the agreed message", cut?.label === "slow" && answers[1].includes("ERR slow was interrupted by an apply, it may have partly run."), { ranMs: cut?.ranMs })
      const hook = of(E, "hook.done", (e) => e.result === "interrupted by a swap")[0]
      c("the afterTurn hook still running then was interrupted and logged, though its own timeout was 120 s", of(E, "hook.interruptedBySwap").length === 1 && hook !== undefined && hook.ms < 40_000, { ranMs: hook?.ms })
      const abandoned = of(E, "close.abandoned")[0]
      c("the finalizer that hangs was abandoned after 10 seconds", abandoned !== undefined && within(abandoned.ms, 9_900, 10_400), { ms: abandoned?.ms })
      c("the new version activated 40 seconds after the gate closed", within(activated.waitedMs, 39_800, 41_500), { waitedMs: activated.waitedMs })
      c("the turn carried on after the cut, and its next call failed as changed", answers[1].includes("ERR echo " + CHANGED))
      const waited = of(E, "turn.waitedForSwap")[0]
      c("a turn that started during the swap waited for the activation, 40 s at most", waited !== undefined && waited.ms <= 41_500 && answers[2].includes("OK \"v2 hi"), { ms: waited?.ms })
      const held = of(E, "timer.held")[0]
      c("a timer that fired during the swap was held until the activation, then its turn ran on the new version", held?.why === "held for a swap" && Math.abs(held.t - activated.t) < 200 && answers[3].includes("OK \"v2 hi"), held)
      c("the afterTurn hooks of the turns that ended after the swap ran on the new version", of(E, "hook.done", (e) => e.result === "ok" && e.on.includes("#2@")).length >= 2)
    }
  },
  {
    id: "hooks",
    scenario: "hooks",
    claim: "hooks queued off the reply path run on the new version; a kind it no longer registers is dropped and logged",
    check: (E, c) => {
      const done = of(E, "hook.done")
      const first = of(E, "swap.activated", (e) => e.label === "apply")[1]
      c("the hook that was running finished on the old version, and the swap waited for that one only", done[0].on.includes("#1@") && done[0].result === "ok" && first.waitedMs < 1600, { waitedMs: first.waitedMs })
      const after = done.slice(1, 3)
      c("the two afterTurn hooks still queued ran on the new version", after.length === 2 && after.every((e) => e.on.includes("#2@") && e.kind === "afterTurn"), after.map((e) => e.on))
      const dropped = of(E, "hook.dropped")
      c("the queued Compacted hook was dropped and logged, the new version registers none", dropped[0]?.kind === "Compacted" && String(dropped[0].why).includes("registers no Compacted hook"), dropped[0]?.why)
      const bg = of(E, "plugin.background.interrupted")[0]
      c("the old version's Plugin.background fiber was interrupted at its close, and the drain did not wait for it", bg !== undefined && bg.instance === 1 && bg.t <= first.t)
      c("when the plugin was removed its queued hook was dropped and logged", dropped[1]?.why === "the plugin is removed", dropped[1])
    }
  },
  {
    id: "reload-fail",
    scenario: "reload-fail",
    claim: "a reload that is not an apply, with one plugin that fails to build: the others swap, that one keeps its old version, the command exits 1",
    check: (E, c, answers) => {
      const reload = of(E, "cli.reload")[0]
      c("the command exits 1 and names the failed plugin and its error", reload.exit === 1 && reload.errors[0].startsWith("picky: ") && reload.errors[0].includes("Mars/Olympus"), reload.errors)
      c("the plugin that built was swapped", reload.reloaded.join() === "echo" && answers[1].includes("v1 hi Mars/Olympus #3"))
      c("the one that failed keeps its old version and still answers", answers[1].includes("picky Pacific/Auckland owners=owner-1+owner-2 #2"))
      const status = of(E, "status")[0].status.join(" | ")
      c("chad status marks it as running with the previous timezone", status.includes("running with the previous timezone: "), status)
      const owner = of(E, "cli.reload")[1]
      const after = of(E, "status")[1].status.join(" | ")
      c("when an owner is removed, the plugin whose build fails is unloaded", owner.exit === 1 && after.includes("picky: removed"), after)
      c("its tool is gone from the next turn", answers[2].includes("ERR pick is not defined"))
    }
  },
  {
    id: "stop-drain",
    scenario: "stop-drain",
    claim: "a graceful stop while a swap is draining abandons it",
    phases: [{ stopOn: (E) => E.some((e) => e.ev === "call.held"), stopDelay: 300 }, {}],
    check: (E, c) => {
      const abandoned = of(E, "swap.abandoned")[0]
      c("the swap was abandoned", abandoned !== undefined, abandoned?.report)
      c("the new instance was closed without being activated", of(E, "close.done", (e) => e.why === "abandoned before its activation").length === 1 && of(E, "swap.activated", (e) => e.label.startsWith("reload")).length === 0)
      c("the old version went through the ordinary graceful stop", of(E, "close.done", (e) => e.phase === 1 && e.why === "graceful stop" && e.version.includes("#1@")).length === 1)
      const released = of(E, "call.released")[0]
      const routed = of(E, "call.routed", (e) => e.phase === 1 && e.t >= (released?.t ?? Infinity))[0]
      const heldTurn = of(E, "turn.end", (e) => e.phase === 1 && e.t >= (released?.t ?? Infinity))[0]
      c("FOUND: the call held at the gate was let go, answered by the old version, and its turn ended during the stop", released !== undefined && routed?.to.includes("#1@") && heldTurn?.outcome === "Answered", { heldMs: released?.heldMs, to: routed?.to })
      stopBudget(E, c)
      c("the next boot loads the plugin", of(E, "boot.loaded", (e) => e.phase === 2).length === 1)
      c("the turn the stop cut resumed after the restart and ended with an answer", of(E, "turn.cutByShutdown").length === 1 && of(E, "turn.end", (e) => e.phase === 2 && e.outcome === "Answered").length === 1)
    }
  },
  {
    id: "stop-apply",
    scenario: "stop-apply",
    claim: "a graceful stop after live moved abandons the swap, and the next boot loads the new version",
    phases: [{ stopOn: (E) => E.filter((e) => e.ev === "swap.gateClosed" && e.label === "apply").length === 2, stopDelay: 300 }, {}],
    check: (E, c) => {
      const moved = of(E, "live.moved", (e) => e.phase === 1)
      const term = of(E, "driver.sigterm")[0]
      c("live had moved before the stop", moved.length === 2 && moved[1].t < term.t, moved[1]?.live)
      const abandoned = of(E, "swap.abandoned")[0]
      c("the swap was abandoned and the new version closed without being activated", abandoned !== undefined && of(E, "close.done", (e) => e.why === "abandoned before its activation").length === 1, abandoned?.report)
      const hooks = of(E, "hook.done", (e) => e.phase === 1)
      c("the old version's queued afterTurn hook ran on it during the graceful stop, inside its budget", hooks.length === 2 && hooks.every((e) => e.on.includes("#1@") && e.result === "ok") && hooks[1].t > term.t, hooks.map((e) => e.ms))
      const closed = of(E, "close.done", (e) => e.why === "graceful stop")[0]
      c("the old version closed after its hooks", closed !== undefined && closed.t >= hooks[1].t)
      stopBudget(E, c)
      const boot = of(E, "boot.loaded", (e) => e.phase === 2)[0]
      const oldHash = of(E, "build.ok", (e) => e.phase === 1)[0].version.split("@")[1]
      c("the next boot loads the new version", boot !== undefined && boot.live === moved[1].live && !boot.plugins[0].endsWith(oldHash), boot?.plugins)
      const end = of(E, "turn.end", (e) => e.phase === 2)[0]
      c("the cut turn resumed on the new version", end?.outcome === "Answered" && String(end.text).includes("v2 hi"), String(end?.text).slice(0, 160))
    }
  },
  {
    id: "stop-before-commit",
    scenario: "stop-before-commit",
    claim: "a graceful stop before the commit cancels the apply and changes nothing",
    env: { PROTO_BUILD_DELAY: "1500" },
    phases: [{ stopOn: (E) => E.filter((e) => e.ev === "apply.built").length === 2, stopDelay: 200 }, {}],
    check: (E, c, answers) => {
      const moved = of(E, "live.moved")
      const cancelled = of(E, "apply.cancelledBeforeCommit")[0]
      c("the apply was cancelled and live did not move", cancelled !== undefined && moved.length === 1 && cancelled.live === moved[0].live, cancelled?.live)
      c("the version it had built was closed", of(E, "close.done", (e) => e.why === "the apply was cancelled before its commit").length === 1)
      stopBudget(E, c)
      c("the next boot loads the old version", answers[0]?.includes("OK \"v1 hi") && of(E, "answer")[0].phase === 2, answers[0])
    }
  },
  {
    id: "stop-close",
    scenario: "stop-close",
    claim: "a graceful stop while the old scope is closing: the plugin is between its close and its activation",
    phases: [{ stopOn: (E) => E.some((e) => e.ev === "plugin.closing" && e.instance === 1), stopDelay: 300 }, {}],
    check: (E, c, answers) => {
      const abandoned = of(E, "swap.abandoned")[0]
      c("the swap was abandoned with the old version closed and the new one never activated", abandoned?.report[0].includes("old version closed, new one never activated"), abandoned?.report)
      const dropped = of(E, "hook.dropped")[0]
      c("the queued hook was dropped with a log line", dropped?.why === "the plugin is between its close and its activation", dropped)
      const refused = of(E, "call.refused", (e) => e.phase === 1)[0]
      c("a call that arrived while the old version was closing failed at once as changed", refused?.at === "closed gate" && refused.message.includes(CHANGED))
      const cut = of(E, "turn.cutByShutdown")[0]
      c("a call after the stop abandoned the swap was not answered: it waited, and the stop cut its turn", of(E, "call.heldForStop").length === 1 && cut !== undefined && of(E, "turn.end", (e) => e.phase === 1).length === 2)
      c("that turn resumed after the restart on the new version", answers.some((a) => a.includes("v2 hi") && a.includes("b-after-the-stop")), answers.find((a) => a.includes("b-after-the-stop"))?.slice(0, 200))
      stopBudget(E, c)
      const later = answers[answers.length - 1]
      c("the next boot loads the new version", of(E, "answer").at(-1).phase === 2 && later.includes("OK \"v2 hi"), later)
    }
  },
  {
    id: "subagent",
    scenario: "subagent",
    claim: "calls from a sub-agent and from a background sub-agent follow the same rules",
    check: (E, c) => {
      const reload = of(E, "swap.activated", (e) => e.label.startsWith("reload"))[0]
      const apply = of(E, "swap.activated", (e) => e.label === "apply")[1]
      const routed = of(E, "call.routed")
      c("both sub-agents' first calls were answered by the first instance", routed.filter((e) => e.t < reload.t && e.to.includes("#1@")).length === 2)
      c("after chad plugin reload both sub-agents' calls were routed to the new instance", routed.filter((e) => e.t >= reload.t && e.to.includes("#2@")).length === 2)
      const refused = of(E, "call.refused")
      c("after an apply that changed the code both sub-agents' calls failed with the agreed message", refused.length === 2 && refused.every((e) => e.t >= apply.t && e.message.includes(CHANGED_SUB)), refused[0]?.message)
      c("the apply output counts the session's sub-agents", apply.affected.length === 1 && apply.affected[0].includes("2 sub-agents running"), apply.affected)
      c("both sub-agents finished and the turn ended with an answer", of(E, "brain.subagentComplete").length === 2 && of(E, "turn.end")[0]?.outcome === "Answered")
    }
  },
  {
    id: "bg-open",
    scenario: "bg-open",
    claim: "a background sub-agent the script does not wait for",
    check: (E, c, answers) => {
      c("clanka keeps the turn open while the background sub-agent runs, after the model has answered", of(E, "bg.turnStillOpen")[0]?.open === true)
      const refused = of(E, "call.refused")
      c("so its calls are a running turn's calls: routed after a reload, refused after a code change", of(E, "call.routed", (e) => e.to.includes("#2@")).length === 1 && refused.some((e) => e.t > of(E, "script.mark", (m) => m.label === "steered")[0].t))
      const steered = of(E, "message.steered")[0]
      c("FOUND: the owner's next message is steered into the open turn, on the old Agent, and its call fails as changed", steered !== undefined && of(E, "agent.built").length === 2 && of(E, "agent.built")[1].t > of(E, "turn.end")[0].t && refused[0]?.message.includes(CHANGED_SUB), refused[0]?.message)
      c("the turn ended once the sub-agent finished, and the turn after it has the new version", of(E, "turn.end").length === 2 && answers[1].includes("OK \"v2 hi"))
    }
  },
  {
    id: "shape",
    scenario: "shape",
    claim: "the same bundle with other settings: comparing the rendered declarations",
    check: (E, c, answers) => {
      const lines = answers[0].split("\n")
      c("a tool whose description is built from a setting fails as changed once that setting changes", lines[3].includes("ERR measure " + CHANGED) && of(E, "call.refused")[0]?.at === "declaration", lines[3])
      c("the other tools of the same plugin, whose declarations did not change, are routed", lines[4].includes("#2") && lines[5].includes("shaped #2"))
      c("a schema that changed behind an unchanged declaration: the call is routed and the parameters are carried across, so the new handler gets what its own schema decodes", lines[7].includes('schema says trimmed, stored \\"bob\\" #3'), lines[7])
      c("parameters the new schema rejects fail as a parameter error, and the handler does not run", lines[10].startsWith("ERR label: the parameters do not fit the version an apply loaded.") && of(E, "call.refused", (e) => e.at === "parameters").length === 1, lines[10].slice(0, 200))
      c("a tool with no parameters is still routed", lines[11].includes("shaped #4"))
    }
  },
  {
    id: "shape-raw",
    scenario: "shape",
    claim: "the same without carrying the parameters across (PROTO_NO_RECODE=1)",
    env: { PROTO_NO_RECODE: "1" },
    check: (E, c, answers) => {
      const lines = answers[0].split("\n")
      c("the new handler is handed what the old Agent's schema decoded: untrimmed under a schema that trims, 7 characters under a minimum of 10", lines[7].includes('schema says trimmed, stored \\"  bob  \\" #3') && lines[10].includes('stored \\"  bob  \\" #4'), lines[10])
    }
  },
  {
    id: "shape-result",
    scenario: "shape-result",
    claim: "a result the Agent's schema no longer accepts",
    check: (E, c, answers) => {
      const lines = answers[0].split("\n")
      const refused = of(E, "call.resultRefused")[0]
      c("the first call returned five characters", lines[0] === 'OK "xxxxx"', lines[0])
      c("after the limit was raised the call was routed and the handler ran on the new instance", of(E, "call.routed", (e) => e.to.includes("#2@") && e.recoded === true).length === 1 && refused?.on.includes("#2@"))
      c("its result failed the Agent's schema, and the message says the call ran", lines[1].startsWith("ERR report ran, but its result does not fit the declaration this turn was built with."), lines[1].slice(0, 220))
    }
  },
  {
    id: "stubborn",
    scenario: "stubborn",
    claim: "a handler that ignores the interruption (drain 1.5 s, close 1 s here)",
    env: { PROTO_DRAIN: "1500", PROTO_CLOSE: "1000", PROTO_STUBBORN: "300" },
    check: (E, c, answers) => {
      const ignored = of(E, "flight.ignoredInterrupt")[0]
      const activated = of(E, "swap.activated", (e) => e.label === "apply")[1]
      c("the caller was told the handler did not stop", answers[0].includes("ERR stuck did not stop when an apply interrupted it and may still be running."))
      c("the swap waited 0.3 s for it and no longer, and that came out of the close deadline", ignored !== undefined && within(activated.waitedMs, 1700, 2600), { waitedMs: activated.waitedMs, note: ignored?.note })
      const ended = of(E, "flight.endedAfterAbandon")[0]
      const end = of(E, "plugin.stuck.end")[0]
      c("FOUND: the handler ran on for seconds inside a closed version", ended !== undefined && ended.ranMs > 5500 && end?.connectionOpen === false, { ranMs: ended?.ranMs, connectionOpen: end?.connectionOpen })
    }
  },
  {
    id: "hole",
    scenario: "hole",
    claim: "why the rule is by bundle hash: NumberFromString became String",
    check: (E, c, answers) => {
      c("with the rule, the running turn's call fails as changed", answers[0].includes("ERR store " + CHANGED))
    }
  },
  {
    id: "hole-any",
    scenario: "hole",
    claim: "the same with the rejected rule, route by tool name (PROTO_ROUTE_ANY=1)",
    env: { PROTO_ROUTE_ANY: "1" },
    check: (E, c, answers) => {
      c("the new handler, written for a string, is handed a number decoded by the old Agent's schema", answers[0].includes("written for a string, got a number"), answers[0].slice(-110))
    }
  }
]

const wanted = process.argv.slice(2)
const chosen = wanted.length === 0 ? specs : specs.filter((s) => wanted.includes(s.id))
// The scenarios do not share a file, so they run side by side.
await Promise.all(chosen.map(runSpec))
if (wanted.length === 0) {
  // Group the lines by scenario, in the order above.
  const lines: Array<string> = []
  for (const spec of specs) {
    const start = results.indexOf("## " + spec.id + ": " + spec.claim)
    lines.push("", results[start])
    lines.push(...results.filter((l) => l.includes("  [" + spec.id + "]  ")))
  }
  const pass = lines.filter((l) => l.startsWith("PASS")).length
  const fail = lines.filter((l) => l.startsWith("FAIL")).length
  writeFileSync(OUT + "/results.txt", "node " + process.version + ", " + new Date().toISOString() + "\n" + pass + " passed, " + fail + " failed\n" + lines.join("\n") + "\n")
}
const failed = results.filter((l) => l.startsWith("FAIL")).length
console.log("\n" + results.filter((l) => l.startsWith("PASS")).length + " passed, " + failed + " failed")
process.exit(failed === 0 ? 0 : 1)
