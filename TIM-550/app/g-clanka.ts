// Claim G: real clanka AgentExecutor (real bash/rg/gh tool handlers) with a wrapped spawner.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { layerSessionSpawner, type Mode } from "./session-spawner.ts"

const say = (s: string) => console.log(s)

// fake rg and gh first on PATH so the child itself reports what it sees
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "chad-fakebin-"))
for (const name of ["rg", "gh"]) {
  fs.writeFileSync(
    path.join(fakeBin, name),
    `#!/bin/sh\necho "fake-${name} sees CHAD_SESSION=[$CHAD_SESSION] HOME=[$HOME] nvars=$(env | grep -c .)"\n`,
    { mode: 0o755 }
  )
}
process.env.PATH = fakeBin + ":" + process.env.PATH
say("parent env: nvars=" + Object.keys(process.env).length + " CHAD_SESSION=" + JSON.stringify(process.env.CHAD_SESSION))

const executorLayer = (id: string, mode: Mode, directory: string) =>
  AgentExecutor.layerLocal({ directory }).pipe(
    Layer.provide(layerSessionSpawner(id, { mode, log: say })),
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
  )

const runScript = (script: string) =>
  Effect.gen(function* () {
    const executor = yield* AgentExecutor.AgentExecutor
    const caps = yield* executor.capabilities
    const out = yield* executor
      .execute({
        script,
        environment: caps.environment,
        onEnvironment: () => Effect.void,
        onTaskComplete: () => Effect.void,
        onImage: () => Effect.void,
        agentTasks: {
          subagent: () => Effect.die("no subagent here"),
          taskOutput: () => Effect.fail("n/a"),
          waitTasks: () => Effect.fail("n/a"),
          messageAgent: () => Effect.void,
          stopTask: () => Effect.void,
          listTasks: Effect.succeed([])
        } as any
      })
      .pipe(Stream.mkString)
    return out
  })

const session = (id: string, mode: Mode, script: string) =>
  runScript(script).pipe(
    Effect.provide(executorLayer(id, mode, fs.mkdtempSync(path.join(os.tmpdir(), "chad-g-")))),
    Effect.scoped
  )

const bashScript = `const t = await bash({ command: 'echo "[$CHAD_SESSION]"; env | grep -c .; echo "PATH=$(echo "$PATH" | cut -c1-40)... HOME=$HOME"' })
console.log(t.output)`

const program = Effect.gen(function* () {
  say("\n=== (i)+(ii) foreground bash, mode=extend ===")
  say(yield* session("sess-A", "extend", bashScript))

  say("\n=== (ii-negative) foreground bash, mode=naive-setEnv (ChildProcess.setEnv only) ===")
  say(yield* session("sess-N", "naive-setEnv", bashScript).pipe(Effect.catchCause((c) => Effect.succeed("FAILED: " + String(c)))))

  say("\n=== (iii) background bash ===")
  say(
    yield* session(
      "sess-B",
      "extend",
      `const t = await bash({ command: 'sleep 0.3; echo "bg:[$CHAD_SESSION] HOME=$HOME nvars=$(env | grep -c .)"', background: true })
console.log("started", t.id, t.status)
await sleep(900)
const o = await taskOutput(t.id)
console.log(o.status, o.output)`
    )
  )

  say("\n=== (iv) rg and gh tools (fake binaries first on PATH) ===")
  say(
    yield* session(
      "sess-C",
      "extend",
      `console.log("rg ->", await rg({ pattern: "needle" }))
console.log("gh ->", await gh(["--version"]))
console.log("run ->", await run('echo "run:[$CHAD_SESSION]"'))`
    )
  )

  say("\n=== (v) two sessions at once ===")
  const slow = (tag: string) =>
    `const t = await bash({ command: 'sleep 0.5; echo "${tag} sees [$CHAD_SESSION] at $(date +%s.%N)"' })
console.log(t.output)`
  const both = yield* Effect.all([session("sess-X", "extend", slow("X")), session("sess-Y", "extend", slow("Y"))], {
    concurrency: 2
  })
  say(both.join(""))

  say("\n=== (vii) executor built with sess-OUTER; a different spawner (sess-PER-CALL) provided around one execute call ===")
  say(
    yield* runScript(`console.log((await bash({ command: 'echo "saw [$CHAD_SESSION]"' })).output)`).pipe(
      Effect.provide(layerSessionSpawner("sess-PER-CALL", { log: say }).pipe(Layer.provide(NodeServices.layer))),
      Effect.provide(executorLayer("sess-OUTER", "extend", fs.mkdtempSync(path.join(os.tmpdir(), "chad-g-")))),
      Effect.scoped
    )
  )
})

NodeRuntime.runMain(program.pipe(Effect.ensuring(Effect.sync(() => fs.rmSync(fakeBin, { recursive: true, force: true })))))
