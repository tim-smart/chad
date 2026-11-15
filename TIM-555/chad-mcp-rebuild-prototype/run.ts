// PROTOTYPE for "The plugin swap run with live sessions" (TIM-552). Throwaway.
// The driver: starts scenarios.ts as child processes, sends SIGTERM at chosen events, restarts
// them on the same SQLite file and plugin repo, and checks the event log.
//   node run.ts              every scenario
//   node run.ts gate hooks   only those
//   node run.ts mcp          every scenario of "The MCP layer rebuild run with calls in flight" (TIM-555)
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
  rmSync(OUT + "/ctl-" + spec.id, { recursive: true, force: true })
  mkdirSync(OUT + "/ctl-" + spec.id, { recursive: true })
  const pids: Array<number> = []
  const phases = spec.phases ?? [{}]
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]
    const fd = openSync(OUT + "/" + spec.id + ".stdout", "a")
    const child = spawn(process.execPath, ["scenarios.ts", spec.scenario, String(i + 1)], {
      env: { ...process.env, PROTO_DB: OUT + "/" + spec.id + ".sqlite", PROTO_LOG: logFile, PROTO_WORK: OUT + "/work-" + spec.id, PROTO_REPO: OUT + "/repo-" + spec.id, MCP_CTL: OUT + "/ctl-" + spec.id, ...spec.env, ...phase.env },
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

// =============================================================================================
// "The MCP layer rebuild run with calls in flight" (TIM-555)
// =============================================================================================
const NOT_SENT = "MCP servers are restarting. This call was not sent."
const STARTED_DURING = "MCP servers were restarting when this turn started. They are back in your next turn."
const CUT_MCP = "was interrupted by an MCP restart, it may have partly run."
const REMOVED_MCP = "was removed by an apply and is gone from your next turn."
/** The rebuild after the first apply: gate, ready and what lies between. */
const rebuildOf = (E: Array<any>, label: string) => {
  const gate = of(E, "mcp.gateClosed", (e) => e.label === label && e.layer !== null)[0]
  const after = (ev: string) => E.find((e) => e.ev === ev && e.label === label && e.t >= gate.t && E.indexOf(e) > E.indexOf(gate))
  return { gate, drained: after("mcp.drained"), closed: after("mcp.closed"), ready: after("mcp.ready"), connected: E.find((e) => e.ev === "mcp.connected" && e.why === label && E.indexOf(e) > E.indexOf(gate)) }
}
const startSpec = (mode: "none" | "fail" | "route"): Spec => ({
  id: "mcp-start-" + mode,
  scenario: "mcp-start",
  env: { PROTO_MCP_HELD: "3000", PROTO_MCP_START: "3000", PROTO_MCP_STARTMODE: mode },
  claim: {
    none: "rule 6 as written, with a 3 s cap: the turn that gave up starts without MCP. It has no handler keys, so its calls cannot be given the agreed message",
    fail: "rule 6 read another way, with a 3 s cap: the turn that gave up keeps the previous layer's keys and each call fails with the agreed message",
    route: "rule 6 read a third way, with a 3 s cap: the turn that gave up keeps the previous layer's keys and is treated like a running turn"
  }[mode],
  check: (E, c, answers) => {
    const { gate, ready } = rebuildOf(E, "chad mcp restart")
    const gaveUp = of(E, "mcp.turn.gaveUp")[0]
    c("the turn that started during the rebuild gave up waiting at the cap, before the new layer was ready", gaveUp !== undefined && within(gaveUp.ms, 2900, 3600) && gaveUp.t < ready.t, { waitedMs: gaveUp?.ms, readyAfterMs: ready.t - gate.t })
    const keys = of(E, "mcp.keysTaken", (e) => e.t >= gaveUp.t)[0]
    const system = of(E, "turn.system", (e) => e.t >= gaveUp.t)[0]
    if (mode === "none") {
      c("it has no MCP section in its prompt and no handler keys", keys.keys.length === 0 && system.hasMcpSection === false)
      c("its MCP calls fail with \"mcp is not defined\": the script has no such name, and chad's wrapper is never reached", answers[1] === "ERR mcp is not defined\nERR mcp is not defined\n" && of(E, "mcp.call.refused").length === 0, answers[1])
      c("the second of them was made after the new layer was ready, and fails the same way", of(E, "turn.end")[1].t > ready.t)
    } else if (mode === "fail") {
      c("it has the previous layer's keys and MCP section", keys.keys.includes("fs.echo") && system.hasMcpSection === true)
      c("each MCP call fails with the agreed message, the one made after the new layer was ready too", answers[1] === ("ERR " + STARTED_DURING + "\n").repeat(2) && of(E, "mcp.call.refused").length === 2 && of(E, "mcp.call.refused")[1].t > ready.t, answers[1])
    } else {
      c("it has the previous layer's keys and MCP section", keys.keys.includes("fs.echo") && system.hasMcpSection === true)
      const released = of(E, "mcp.call.released")[0]
      c("its first MCP call was held at the gate and answered by the new layer", released !== undefined && /v2 fs pid \d+ token none: a1/.test(answers[1]), { heldMs: released?.heldMs })
      c("its second was routed to the new layer", /v2 fs pid \d+ token none: a2/.test(answers[1]))
    }
    c("the session's next turn has MCP on the new layer", /v2 fs pid \d+ token none: a3/.test(answers[2]) && of(E, "agent.built").at(-1).mcp === "2")
  }
})
const subSpec = (mode: "none" | "route"): Spec => ({
  id: "mcp-sub-" + mode,
  scenario: "mcp-sub",
  env: { PROTO_MCP_STARTMODE: mode },
  claim: mode === "none"
    ? "a sub-agent spawned by a running turn while no layer is current, when such a spawn gets no keys: it has no MCP for its whole life"
    : "the same sub-agent when the spawn gets the previous layer's keys: its call is held at the gate and answered by the new layer",
  check: (E, c, answers) => {
    const { closed, ready } = rebuildOf(E, "chad mcp restart")
    const keys = of(E, "mcp.keysTaken", (e) => e.t >= closed.t)[0]
    c("the sub-agent took its handler keys after the old layer closed and before the new one was ready", keys !== undefined && keys.layer === null && keys.t < ready.t, { keys: keys?.keys.length })
    if (mode === "none") c("its MCP call fails with \"mcp is not defined\"", answers[0].includes("SUB") && answers[0].includes("ERR mcp is not defined"), answers[0].split("\n").find((l) => l.startsWith("SUB")))
    else {
      const released = of(E, "mcp.call.released")[0]
      c("its MCP call was held and then answered by the new layer", released !== undefined && /v2 fs pid \d+ token none: sub1/.test(answers[0]), { heldMs: released?.heldMs })
    }
    c("the parent turn's own call after the rebuild is answered by the new layer", /OK "v2 fs pid \d+ token none: a-after/.test(answers[0]))
  }
})
const stubbornSpec = (pause: number): Spec => ({
  id: pause === 0 ? "mcp-stubborn" : "mcp-stubborn-pause",
  scenario: "mcp-stubborn",
  env: { PROTO_MCP_DRAIN: "1500", MCP_PORT: pause === 0 ? "39555" : "39556", PROTO_MCP_PAUSE: String(pause) },
  claim: pause === 0
    ? "a call the server does not stop, on a stdio server that exits when asked, two that ignore stdin closing and SIGTERM, and one over HTTP (drain shortened to 1.5 s)"
    : "the same with a 250 ms pause between interrupting the calls and closing the old layer, which is not in the rules",
  check: (E, c, answers) => {
    const { drained, closed, ready } = rebuildOf(E, "chad mcp restart")
    c("all four callers got the agreed interrupted message", ["soft", "hard1", "hard2", "remote"].every((n) => answers[0].includes("ERR mcp." + n + ".stubborn " + CUT_MCP)))
    const stopped = of(E, "mcp.call.stopped")
    c("every call stopped at once on chad's side; the 1 second wait and the \"did not stop\" message never came up", stopped.length === 4 && stopped.every((e) => e.stopped === true && e.ms < 200) && !answers[0].includes("did not stop"), stopped.map((e) => e.ms))
    c("each stdio server was told to cancel", ["soft", "hard1", "hard2"].every((n) => of(E, "server.stubborn.sawCancel", (e) => e.server === n).length === 1))
    const http = of(E, "server.http", (e) => e.t >= drained.t - 50 && e.t < closed.t).map((e) => e.method + " " + e.rpc)
    const told = of(E, "server.stubborn.sawCancel", (e) => e.server === "remote").length
    if (pause === 0) c("the HTTP server was not told to cancel: no request reached it between the interrupt and the end of the close", told === 0 && http.length === 0, http)
    else c("with the pause the HTTP server was told to cancel", told === 1 && http.includes("POST notifications/cancelled"), http)
    c("the HTTP server's session was not deleted when the old layer closed", of(E, "server.sessionDeleted").length === 0)
    const ended = of(E, "stubborn.settled")[0].ended
    c("the work carried on to its end on the HTTP server and on the stdio server that was closed last; the stdio server closed first was killed before it finished", ended.includes("remote") && ended.includes("soft") && !ended.includes("hard2"), ended)
    c("closing the old layer took 4 seconds for each server that ignores stdin closing and SIGTERM, one after the other", within(closed.ms, 7800, 8800), { closeMs: closed.ms })
    const released = of(E, "mcp.call.released")[0]
    c("the turn's next call was held for all of that and answered by the HTTP server, which was never restarted", released !== undefined && released.heldMs > 7000 && /r1 remote pid \d+ token none: after/.test(answers[0]) && of(E, "server.start", (e) => e.server === "remote").length === 1, { heldMs: released?.heldMs })
    const stop = of(E, "mcp.closed", (e) => e.label === "graceful stop")[0]
    c("the graceful stop at the end spent the same 8 seconds closing the layer", stop !== undefined && within(stop.ms, 7800, 8800), { closeMs: stop?.ms })
  }
})
const stopPhases: ReadonlyArray<Phase> = [{ stopOn: (E) => E.some((e) => e.ev === "mcp.call.held"), stopDelay: 300 }, {}]
specs.push(
  {
    id: "mcp-route",
    scenario: "mcp-route",
    claim: "rules 1 and 7: every Agent has the one wrapper, a running turn's call goes to the layer that is current when it is made, each kind of rebuild takes the one path, and an added server is callable from the next turn",
    check: (E, c, answers) => {
      const calls = [...answers[0].matchAll(/OK "(\w+) fs pid (\d+) token (\w+): ([a-d])"/g)].map((x) => ({ label: x[1], pid: x[2], token: x[3], text: x[4] }))
      const firstEnd = of(E, "turn.end")[0]
      c("one turn on one Agent made four calls, answered by four server processes", of(E, "agent.built", (e) => e.t < firstEnd.t).length === 1 && calls.length === 4 && new Set(calls.map((x) => x.pid)).size === 4, calls.map((x) => x.label + " pid " + x.pid + " token " + x.token))
      c("after chad mcp restart the running turn's call is answered by the restarted server", calls[0].label === "v1" && calls[1].label === "v2")
      c("after a change to a secret that mcp.json names, by a server started with the new secret", calls[1].token === "t1" && calls[2].token === "t2" && of(E, "mcp.gateClosed", (e) => e.label === "secret FS_TOKEN").length === 1)
      c("a change to a secret that mcp.json does not name rebuilds nothing", of(E, "mcp.secretNotNamed").length === 1 && of(E, "mcp.gateClosed").length === 4)
      c("after an apply that changed mcp.json, by another new server", calls[3].pid !== calls[2].pid)
      const order = of(E, "mcp.gateClosed", (e) => e.layer !== null).map((g) => E.slice(E.indexOf(g)).filter((e) => ["mcp.gateClosed", "mcp.drained", "mcp.closed", "mcp.connected", "mcp.ready"].includes(e.ev)).slice(0, 5).map((e) => e.ev.slice(4)).join(" "))
      c("all three rebuilds ran gate, drain, close, connect in that order", order.length === 3 && order.every((o) => o === "gateClosed drained closed connected ready"), order[0])
      c("rule 7: the server the apply added is callable from the session's next turn and from another session", /x1 extra pid \d+ token none: f/.test(answers[1]) && /x1 extra pid \d+ token none: h/.test(answers[2]))
      c("the running turn has no name for the added server: its call throws in the script and never reaches chad", answers[0].includes("ERR Cannot read properties of undefined (reading 'echo')"))
      c("searchTools in that same turn lists the added server all the same", answers[0].includes("SEARCH") && answers[0].includes("declare namespace mcp.extra"))
      c("a sub-agent that turn spawns after the rebuild can call the added server", /x1 extra pid \d+ token none: sub-extra/.test(answers[0]))
    }
  },
  {
    id: "mcp-gate",
    scenario: "mcp-gate",
    claim: "rules 2 and 3: a call in flight finishes on the old layer, a call that arrives at the closed gate is held and answered by the new layer",
    check: (E, c, answers) => {
      const { gate, drained, ready } = rebuildOf(E, "chad mcp restart")
      c("the call in flight when the gate closed finished on the old layer, and the rebuild waited for it", /v1 fs pid \d+ token none: slow a/.test(answers[0]) && within(drained.ms, 2000, 3500) && ready.interrupted.length === 0, { drainedMs: drained.ms })
      const held = of(E, "mcp.call.held")[0]
      const released = of(E, "mcp.call.released")[0]
      c("a call that arrived at the closed gate was held", held !== undefined && held.t >= gate.t && held.t < ready.t, { heldMs: released?.heldMs })
      c("it was released when the new layer was ready and answered by it", released !== undefined && released.t >= ready.t - 5 && /v2 fs pid \d+ token none: b-during/.test(answers[1]), answers[1])
      const exit = of(E, "server.exit")[0]
      const start = of(E, "server.start", (e) => e.label === "v2")[0]
      c("the old server had exited before the new one started", exit !== undefined && start !== undefined && exit.t <= start.t, { msBetween: start.t - exit.t })
    }
  },
  {
    id: "mcp-deadlines",
    scenario: "mcp-deadlines",
    claim: "rules 2 and 6 with the real 30 s drain: a call that hangs is interrupted with the agreed message, and a turn that starts during the rebuild waits for the new layer",
    check: (E, c, answers) => {
      const { gate, drained, closed, ready } = rebuildOf(E, "chad mcp restart")
      c("the drain took 30 seconds and interrupted the one call still in flight", within(drained.ms, 29_900, 30_600) && drained.interrupted.length === 1, { drainedMs: drained.ms })
      c("the caller got the agreed message", answers[0].includes("ERR mcp.fs.slow " + CUT_MCP), answers[0].split("\n")[0])
      const stopped = of(E, "mcp.call.stopped")[0]
      c("the call stopped at once on chad's side and the server was told to cancel", stopped.stopped === true && stopped.ms < 200 && of(E, "server.slow.cancelled").length === 1, { ms: stopped.ms })
      c("the old layer closed after the drain, and the new server started after that", closed.t >= drained.t && of(E, "server.start", (e) => e.label === "v2")[0].t >= closed.t, { closeMs: closed.ms })
      c("the interrupted turn carried on: its next call was held and answered by the new layer", /v2 fs pid \d+ token none: after the cut/.test(answers[0]))
      const released = of(E, "mcp.call.released", (e) => e.session === "s-c2")[0]
      c("the call held since the gate closed waited 35 seconds and was answered by the new layer", within(released.heldMs, 34_000, 37_000) && /v2 fs pid \d+ token none: b-held/.test(answers[1]), { heldMs: released.heldMs })
      const waited = of(E, "mcp.turn.waited")[0]
      c("rule 6: the turn that started during the rebuild waited for the new layer and took its keys from it", waited !== undefined && within(waited.ms, 34_000, 37_000) && of(E, "agent.built", (e) => e.session === "s-c3")[0].mcp === "2" && /v2 fs pid \d+ token none: c1/.test(answers[2]), { waitedMs: waited?.ms, rebuildMs: ready.t - gate.t })
    }
  },
  {
    id: "mcp-cap",
    scenario: "mcp-cap",
    claim: "rules 3, 4 and 6 with the real 60 s caps, a full drain and a server that never answers: the held call fails \"not sent\", the turn that waited starts without MCP",
    check: (E, c, answers) => {
      const { gate, drained, closed, connected, ready } = rebuildOf(E, "chad mcp restart")
      const refused = of(E, "mcp.call.refused", (e) => e.key === "fs.echo")[0]
      c("rule 3: the call held since the gate closed failed at 60 seconds with the agreed message", refused !== undefined && within(refused.t - gate.t, 59_900, 60_700) && answers[1].includes("ERR " + NOT_SENT), { msAfterGate: refused ? refused.t - gate.t : null })
      c("the server never saw that call", !of(E, "server.echo").some((e) => e.text === "b-held"))
      c("the rebuild outlasted the cap: a full drain, the close, clanka's 30 s connect timeout and 2 s more to kill the server that never answered", ready.waitedMs > 60_000, { rebuildMs: ready.waitedMs, drainMs: drained.ms, closeMs: closed.ms, connectMs: connected.ms })
      c("so the held call failed while the server it was for had been connected for 30 seconds inside a layer that was not current yet", of(E, "server.connected", (e) => e.server === "fs" && e.t > gate.t)[0].t < refused.t - 25_000)
      c("the same turn's next call is answered by the new layer", /v2 fs pid \d+ token none: b-after/.test(answers[1]))
      c("rule 4: a server that is still configured and did not connect is not called removed", answers[1].includes("ERR mcp.slowpoke.echo: MCP server \"slowpoke\" is not connected: connection timed out after 30000ms") && !answers[1].includes("removed"), answers[1].trim().split("\n").at(-1))
      const gaveUp = of(E, "mcp.turn.gaveUp")[0]
      const system = of(E, "turn.system", (e) => e.session === "s-c3")[0]
      c("rule 6: the turn that started during the rebuild gave up at 60 seconds and started without MCP", gaveUp !== undefined && within(gaveUp.ms, 59_900, 60_700) && system.hasMcpSection === false, { waitedMs: gaveUp?.ms })
      c("its MCP call fails with \"mcp is not defined\" and not with the agreed message", answers[2] === "ERR mcp is not defined\n", answers[2])
      c("its next turn has MCP again", /v2 fs pid \d+ token none: c2/.test(answers[3]))
    }
  },
  startSpec("none"), startSpec("fail"), startSpec("route"),
  {
    id: "mcp-start-nowait",
    scenario: "mcp-start",
    env: { PROTO_MCP_START: "0", PROTO_MCP_STARTMODE: "route" },
    claim: "not in the rules: a turn that starts during a rebuild does not wait at all. It starts on the previous layer's keys and is treated like a running turn (held cap left at 60 s)",
    check: (E, c, answers) => {
      const { gate, ready } = rebuildOf(E, "chad mcp restart")
      const start = of(E, "turn.start", (e) => e.t >= gate.t)[0]
      const system = of(E, "turn.system", (e) => e.t >= gate.t)[0]
      c("the turn started at once, 5 seconds before the new layer was ready, with the previous layer's MCP section", system !== undefined && system.t - start.t < 500 && system.hasMcpSection === true && system.t < ready.t - 4000, { startMs: system.t - start.t, readyAfterMs: ready.t - gate.t })
      const released = of(E, "mcp.call.released")[0]
      c("its first MCP call was held at the gate and answered by the new layer", released !== undefined && released.heldMs > 4000 && /v2 fs pid \d+ token none: a1/.test(answers[1]), { heldMs: released?.heldMs })
      c("its second was routed to the new layer", /v2 fs pid \d+ token none: a2/.test(answers[1]))
      c("the session's next turn has MCP on the new layer", /v2 fs pid \d+ token none: a3/.test(answers[2]) && of(E, "agent.built").at(-1).mcp === "2")
    }
  },
  subSpec("none"), subSpec("route"),
  {
    id: "mcp-removed",
    scenario: "mcp-removed",
    claim: "rule 4: what a running turn is told about a removed server, a dropped tool, changed parameters and a server that no longer connects",
    check: (E, c, answers) => {
      const a = answers[0]
      c("a server the apply took out of mcp.json: the removed message", a.includes("ERR mcp.gone.echo " + REMOVED_MCP))
      c("a tool that a server still connected no longer lists after the apply: the removed message", a.includes("ERR mcp.fs.slow " + REMOVED_MCP))
      c("a tool whose parameter changed type: the old argument fails clanka's validation against the new schema", a.includes("ERR mcp.fs.store: Expected number"), a.split("\n").filter((l) => l.includes("Expected")).join(" "))
      c("and it was not sent to the server", of(E, "server.store").length === 2, of(E, "server.store").map((e) => e.type))
      c("the same tool called with the new type is answered by the new server", /OK "v2 fs pid \d+ token none: stored 42 \(number\)"/.test(a))
      const flaky = of(E, "mcp.call.refused", (e) => e.key === "flaky.echo")[0]
      c("a server still in mcp.json that did not connect is not called removed", a.includes("ERR mcp.flaky.echo: MCP server \"flaky\" is not connected: connection timed out after 2000ms"))
      c("that sentence is chad's, built from clanka's status: clanka's layer holds no handler for a server that did not connect", flaky !== undefined && String(flaky.at).startsWith("not in layer"), flaky?.at)
      c("searchTools in the running turn shows the new layer's declarations", a.includes("readonly n: number") && !a.includes("function slow"))
      c("a tool that is gone after a restart that was not an apply cannot be called \"removed by an apply\": the prototype had to word one", a.includes("ERR mcp.fs.echo: \"fs\" no longer lists this tool since the MCP servers restarted (chad mcp restart)."))
    }
  },
  {
    id: "mcp-both",
    scenario: "mcp-both",
    claim: "rule 5: one apply that changes a plugin setting and mcp.json closes both gates together, and the plugin activates without waiting for a slow MCP server",
    check: (E, c, answers) => {
      const { gate, ready } = rebuildOf(E, "apply")
      const pluginGate = of(E, "swap.gateClosed", (e) => e.t >= gate.t)[0]
      c("both gates closed together", pluginGate !== undefined && pluginGate.t - gate.t <= 5, { msApart: pluginGate.t - gate.t })
      const activated = of(E, "apply.pluginsActivated", (e) => e.t >= gate.t)[0]
      c("the plugin activated while the MCP server was still connecting", activated.mcpStillRebuilding === true && activated.t - gate.t < 500 && ready.t - gate.t > 5000, { pluginMs: activated.t - gate.t, mcpMs: ready.t - gate.t })
      const routed = of(E, "call.routed", (e) => e.session === "s-c1" && e.t >= gate.t)[0]
      c("the running turn's plugin call was answered with the new setting before the MCP layer was ready", routed !== undefined && routed.t < ready.t && answers[0].includes("yo Pacific/Auckland #2: a1"), { msAfterGate: routed.t - gate.t })
      const released = of(E, "mcp.call.released")[0]
      c("its MCP call was held and answered by the new layer", released !== undefined && /v2 fs pid \d+ token none: a1/.test(answers[0]), { heldMs: released?.heldMs })
      const waited = of(E, "mcp.turn.waited", (e) => e.session === "s-c2")[0]
      c("a turn that started during the rebuild and used only a plugin tool waited for the MCP layer all the same (rule 6)", waited !== undefined && waited.ms > 4500 && answers[1].includes("yo Pacific/Auckland #2: b1"), { waitedMs: waited?.ms })
    }
  },
  {
    id: "mcp-stop-drain",
    scenario: "mcp-stop-drain",
    phases: stopPhases,
    claim: "a graceful stop while a rebuild drains: the held call goes through routing again against the old layer, which is still current",
    check: (E, c, answers) => {
      stopBudget(E, c)
      c("the abandoned rebuild left the old layer in place", of(E, "mcp.abandoned")[0]?.state === "the old layer stays for the graceful stop")
      const released = of(E, "mcp.call.released")[0]
      const end = of(E, "turn.end", (e) => e.session === "s-c2")[0]
      c("the held call was released, routed again and answered by the old layer", released !== undefined && end !== undefined && /v1 fs pid \d+ token none: b-held/.test(end.text), { heldMs: released?.heldMs })
      c("the rebuild interrupted nothing; the stop cut the turn whose call was in flight, and saved it", of(E, "mcp.call.interrupted").length === 0 && of(E, "turn.cutByShutdown")[0]?.saved === true)
      // Whether it had to wait depends on which came first, the turn or the layer. Either way its Agent is built on the boot's layer.
      const rebuilt = of(E, "agent.built", (e) => e.phase === 2 && e.session === "s-c1")[0]
      c("the next boot connected the MCP layer, and the resumed turn took its keys from it and ended with its answers", rebuilt?.mcp === "1" && answers[0].includes("slow a") && answers[0].includes("a-after"), { waitedMs: of(E, "mcp.turn.waited", (e) => e.phase === 2)[0]?.ms ?? 0 })
      c("the call that was in flight at the stop was sent to the server twice", of(E, "server.slow.start").length === 2)
      c("a new session after the boot has MCP", /v1 fs pid \d+ token none: c1/.test(answers[1]))
    }
  },
  {
    id: "mcp-stop-between",
    scenario: "mcp-stop-between",
    phases: stopPhases,
    claim: "a graceful stop after the old layer closed and before the new one connected: nothing is current, the held call waits for the stop to cut its turn",
    check: (E, c, answers) => {
      stopBudget(E, c)
      const term = of(E, "driver.sigterm")[0]
      const abandoned = of(E, "mcp.abandoned")[0]
      c("the abandoned rebuild left no layer", abandoned?.state === "the old layer is closed and no new one is connected")
      c("abandoning it took 2 seconds: the half-started server did not exit when its stdin closed and was sent SIGTERM", abandoned !== undefined && within(abandoned.t - term.t, 1900, 2600) && of(E, "server.sigterm").length === 1, { ms: abandoned ? abandoned.t - term.t : null })
      c("the held call was not answered and not failed; the stop cut its turn and saved it", of(E, "mcp.call.heldForStop").length === 1 && of(E, "mcp.call.refused").length === 0 && of(E, "turn.cutByShutdown")[0]?.saved === true)
      c("the next boot connected what the apply had committed, and the resumed turn's call was answered by it", /v2 fs pid \d+ token none: b-held/.test(answers[0]))
      c("a new session after the boot has MCP", /v2 fs pid \d+ token none: c1/.test(answers[1]))
    }
  },
  stubbornSpec(0), stubbornSpec(250)
)

// Everything above runs the seven rules as the follow-up on TIM-537 has them.
for (let i = 0; i < specs.length; i++) if (specs[i].id.startsWith("mcp-")) specs[i] = { ...specs[i], env: { PROTO_MCP_RULES: "written", ...specs[i].env } }

// Below: the rules as amended on TIM-555 after that run. These are the prototype's defaults.
const CUT_AMENDED = "was interrupted by an MCP restart. It may have run in part or in full."
specs.push(
  {
    id: "mcp-amended-held",
    scenario: "mcp-held",
    claim: "amended rules 2, 3, 4 and 6 with the real times and a 62 s rebuild: held calls wait for the rebuild to end, and a turn that starts during it does not wait",
    check: (E, c, answers) => {
      const { gate, drained, closed, ready } = rebuildOf(E, "chad mcp restart")
      c("the rebuild took longer than 60 seconds", ready.waitedMs > 60_000, { rebuildMs: ready.waitedMs })
      c("the interrupted call got the amended message", answers[0].includes("ERR mcp.fs.slow " + CUT_AMENDED), answers[0].trim())
      c("the old layer closed 250 ms after the interrupt", within(closed.t - closed.ms - drained.t, 240, 600), { pauseMs: closed.t - closed.ms - drained.t })
      const fs = of(E, "mcp.call.released", (e) => e.session === "s-c2" && e.key === "fs.echo")[0]
      c("a call held since the gate closed waited past 60 seconds and was answered by the new layer", fs !== undefined && fs.heldMs > 60_000 && /v2 fs pid \d+ token none: b-held/.test(answers[1]), { heldMs: fs?.heldMs })
      c("a call held for a server that then failed to connect got the not-connected message and not \"not sent\"", answers[1].includes("ERR mcp.slowpoke.echo: MCP server \"slowpoke\" is not connected: connection timed out after 30000ms") && !answers[1].includes("not sent"), answers[1].trim().split("\n").at(-1))
      const start = of(E, "turn.start", (e) => e.session === "s-c3")[0]
      const system = of(E, "turn.system", (e) => e.session === "s-c3")[0]
      c("the turn that started during the rebuild did not wait: it started on the previous layer's keys and prompt", of(E, "mcp.turn.startsOnPrevious").length === 1 && system.hasMcpSection === true && system.t - start.t < 1000 && system.t < ready.t - 55_000, { startMs: system.t - start.t })
      const late = of(E, "mcp.call.released", (e) => e.session === "s-c3")[0]
      c("its MCP call was held like a running turn's and answered by the new layer", late !== undefined && late.heldMs > 55_000 && /v2 fs pid \d+ token none: c1/.test(answers[2]), { heldMs: late?.heldMs })
    }
  },
  {
    id: "mcp-amended-backstop",
    scenario: "mcp-backstop",
    env: { PROTO_MCP_HELD: "3000" },
    claim: "amended rule 3 with the backstop shortened to 3 s: the held call fails \"not sent\", the rebuild carries on, and the same call made again is held again",
    check: (E, c, answers) => {
      const { gate, ready } = rebuildOf(E, "chad mcp restart")
      const refused = of(E, "mcp.call.refused")[0]
      c("the held call failed at the backstop with the agreed message, before the rebuild ended", refused !== undefined && within(refused.t - gate.t, 2900, 3700) && refused.t < ready.t && answers[0].includes("ERR " + NOT_SENT), { msAfterGate: refused ? refused.t - gate.t : null })
      const again = of(E, "mcp.call.held", (e) => e.t >= refused.t)[0]
      const released = of(E, "mcp.call.released")[0]
      c("the call made again was held again and answered by the new layer", again !== undefined && released !== undefined && /v2 fs pid \d+ token none: again/.test(answers[0]), { heldMs: released?.heldMs })
      c("the server saw one call", of(E, "server.echo").map((e) => e.text).join() === "again")
    }
  },
  {
    id: "mcp-amended-removed",
    scenario: "mcp-removed",
    claim: "amended rule 4: the wording for a removed server, a tool no longer listed and a server that is not connected",
    check: (E, c, answers) => {
      const a = answers[0]
      c("a server taken out of mcp.json", a.includes("ERR mcp.gone.echo: MCP server \"gone\" was removed from mcp.json."))
      c("a tool its server no longer lists after an apply", a.includes("ERR mcp.fs.slow: \"fs\" no longer lists this tool."))
      c("a tool its server no longer lists after chad mcp restart: the same sentence", a.includes("ERR mcp.fs.echo: \"fs\" no longer lists this tool."))
      c("a server still in mcp.json that did not connect", a.includes("ERR mcp.flaky.echo: MCP server \"flaky\" is not connected: connection timed out after 2000ms"))
      c("changed parameters still fail clanka's validation, and the new type is answered", a.includes("ERR mcp.fs.store: Expected number") && /stored 42 \(number\)/.test(a))
      c("searchTools adds no hint when the new layer has nothing this turn lacks", a.includes("SEARCH") && !a.includes("callable from your next turn"))
    }
  },
  {
    id: "mcp-amended-route",
    scenario: "mcp-route",
    claim: "amended rule 7: searchTools in a running turn names the tools it lists that the turn cannot call",
    check: (E, c, answers) => {
      const search = answers[0].split("\n").find((l) => l.startsWith("SEARCH")) ?? ""
      c("searchTools lists the added server and ends with the hint", search.includes("declare namespace mcp.extra") && search.includes("mcp.extra.echo is callable from your next turn."), search.slice(-70))
      c("the call itself still throws in the script", answers[0].includes("ERR Cannot read properties of undefined (reading 'echo')"))
      c("the next turn can call it", /x1 extra pid \d+ token none: f/.test(answers[1]))
      const calls = [...answers[0].matchAll(/OK "(\w+) fs pid (\d+) token (\w+): ([a-d])"/g)]
      c("routing is unchanged: four calls, four server processes", calls.length === 4 && new Set(calls.map((x) => x[2])).size === 4)
    }
  },
  {
    id: "mcp-amended-both",
    scenario: "mcp-both",
    claim: "amended rule 6 next to rule 5: a turn that starts during a slow MCP rebuild and uses only a plugin tool is not held up",
    check: (E, c, answers) => {
      const { gate, ready } = rebuildOf(E, "apply")
      const start = of(E, "turn.start", (e) => e.session === "s-c2")[0]
      const end = of(E, "turn.end", (e) => e.session === "s-c2")[0]
      c("it started and ended while the MCP server was still connecting", of(E, "mcp.turn.startsOnPrevious", (e) => e.session === "s-c2").length === 1 && end.t < ready.t - 3000 && answers.some((x) => x.includes("yo Pacific/Auckland #2: b1")), { turnMs: end.t - start.t, mcpReadyAfterMs: ready.t - gate.t })
      c("the running turn's MCP call was still held and answered by the new layer", answers.some((x) => /v2 fs pid \d+ token none: a1/.test(x)))
    }
  },
  {
    id: "mcp-amended-boot",
    scenario: "mcp-boot",
    phases: [{}, { env: { PROTO_MCP_HELD: "3000" } }],
    claim: "amended rule 6 at boot, where no layer has connected yet, with the backstop shortened to 3 s and a server that takes 6: the turn waits, then starts without MCP and its prompt says so",
    check: (E, c, answers) => {
      const boot = of(E, "mcp.gateClosed", (e) => e.label === "boot")[0]
      const ready = of(E, "mcp.ready", (e) => e.label === "boot")[0]
      const gaveUp = of(E, "mcp.turn.gaveUp")[0]
      c("the turn waited for the boot's layer up to the backstop", gaveUp !== undefined && within(gaveUp.ms, 2900, 3700) && gaveUp.t < ready.t, { waitedMs: gaveUp?.ms, bootLayerReadyMs: ready.t - boot.t })
      const system = of(E, "turn.system", (e) => e.phase === 2)[0]
      c("it started without MCP, and its prompt has the line that says so", system.hasMcpSection === false && system.saysStillStarting === true)
      c("its MCP call throws \"mcp is not defined\"", answers[1] === "ERR mcp is not defined\n", answers[1])
      c("its next turn has MCP and no such line", /v2 fs pid \d+ token none: a2/.test(answers[2]) && of(E, "turn.system", (e) => e.phase === 2)[1].saysStillStarting === false)
    }
  }
)
const wanted = process.argv.slice(2)
const chosen = wanted.length === 0 ? specs : specs.filter((s) => wanted.includes(s.id) || (wanted.includes("mcp") && s.id.startsWith("mcp-")))
// The scenarios do not share a file, so they run side by side, RUN_JOBS at a time. With all of
// them at once (40 processes and their MCP servers) the timing checks start to fail.
const jobs = Number(process.env.RUN_JOBS ?? 8)
const queue = [...chosen]
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let spec = queue.shift(); spec !== undefined; spec = queue.shift()) await runSpec(spec)
}))
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
