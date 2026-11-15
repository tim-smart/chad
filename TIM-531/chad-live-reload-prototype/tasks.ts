// PROTOTYPE for "Applying a plugin change to a live session" (TIM-531).
// Throwaway. What a rebuilt Agent can see of background bash tasks.
//   PROTO_MODE=control   no rebuild
//   PROTO_MODE=rebuild   rebuild between turn 1 and turn 2
//   PROTO_MODE=stable    rebuild, and chad wraps the executor so the root
//                        agent's task owner id is the same before and after
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Agent, AgentExecutor } from "clanka"
import * as OpenAiCompat from "clanka/OpenAiCompat"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mode = process.env.PROTO_MODE ?? "rebuild"
const scratch = mkdtempSync(join(tmpdir(), "chad-proto-tasks-"))

const program = Effect.gen(function*() {
  const outer = yield* Effect.scope
  const executorScope = yield* Scope.fork(outer)
  const base = yield* Layer.buildWithScope(AgentExecutor.layerLocal({ directory: scratch }), executorScope)
  const real = Context.get(base, AgentExecutor.AgentExecutor)

  // The first id an Agent executes under is its root's: sub-agents only
  // exist once a root script has started one.
  const stableOwner = () => {
    let root: string | undefined
    return AgentExecutor.AgentExecutor.of({
      capabilities: real.capabilities,
      executeUnsafe: real.executeUnsafe,
      renderEnvironment: real.renderEnvironment,
      execute: (options) => {
        root ??= options.agentId
        return real.execute(options.agentId === root ? { ...options, agentId: "session-1" } : options)
      }
    })
  }

  const build = Effect.gen(function*() {
    const scope = yield* Scope.fork(outer)
    const agent = yield* Agent.makeWith({ skills: [], instructions: Option.none() }).pipe(
      Effect.provideService(AgentExecutor.AgentExecutor, mode === "stable" ? stableOwner() : real),
      Scope.provide(scope)
    )
    return { agent, scope }
  })

  let live = yield* build
  const turn = Effect.fnUntraced(function*(text: string) {
    const before = live.agent.history.current.content.length
    const outputs: Array<string> = []
    const stream = yield* live.agent.send({ prompt: text })
    const answer = yield* stream.pipe(
      Stream.runForEach((part) => Effect.sync(() => { if (part._tag === "ScriptOutput") outputs.push(part.output) })),
      Effect.as("(no answer)"),
      Effect.catchTag("AgentFinished", (finished) => Effect.succeed(finished.summary))
    )
    console.log("\n> " + text)
    for (const o of outputs) console.log("  output  " + o.trim().split("\n").filter((l) => !l.includes("INFO")).join("\n          "))
    console.log("  answer  " + answer.trim().replace(/\n/g, "\n          "))
    const pushed = live.agent.history.current.content.slice(before).flatMap((m) =>
      m.role === "user" ? m.content.flatMap((p) => p.type === "text" && p.text.trimStart().startsWith("<task ") ? [p.text.split("\n")[0]] : []) : []
    )
    console.log("  pushed  " + (pushed.join(" ") || "none"))
  }, Effect.scoped)

  yield* turn("Start two background bash tasks with bash({ command, background: true }): 'sleep 4; echo quick-done' and 'sleep 40; echo slow-done'. Reply with the two task ids only. Do not wait for them.")
  yield* Effect.sleep("9 seconds")
  console.log("\n-- 9s later: the quick task has ended, the slow one is running")

  if (mode !== "control") {
    const next = yield* build
    MutableRef.set(next.agent.history, live.agent.history.current)
    MutableRef.set(next.agent.environment, live.agent.environment.current)
    yield* Scope.close(live.scope, Exit.void)
    live = next
    console.log("-- Agent rebuilt")
  }

  yield* turn("In one script, print JSON.stringify(await listTasks()), then for each of the two task ids you started print the result of taskOutput(id), catching and printing any error message. Then tell me in one sentence what state the two tasks are in.")
  yield* Effect.sleep("38 seconds")
  console.log("\n-- 38s later: the slow task has ended")
  yield* turn("Without running anything: has the slow task finished, as far as you know? One sentence.")
  yield* Scope.close(executorScope, Exit.void)
})

console.log("mode " + mode)
program.pipe(
  Effect.scoped,
  Effect.provide([
    OpenAiCompat.model(process.env.PROTO_MODEL ?? "gpt-5.6-luna", { reasoning: { effort: "low" } } as any).pipe(
      Layer.provide(OpenAiCompat.layerClient({
        apiKey: Redacted.make(process.env.CLANKA_OPENAI_API_KEY!),
        apiUrl: process.env.CLANKA_OPENAI_API_URL!
      }))
    ),
    Agent.ConversationMode.layer(true)
  ]),
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
  NodeRuntime.runMain
)
