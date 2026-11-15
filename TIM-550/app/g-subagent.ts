// Claim G (vi): real clanka Agent loop + real local executor + scripted LanguageModel.
// Root agent calls subagent(); the child runs bash. Does the child see CHAD_SESSION?
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { layerSessionSpawner } from "./session-spawner.ts"

const say = (s: string) => console.log(s)

const messageText = (message: Prompt.Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part: any) => (part.type === "text" ? part.text : "")).join("")
const firstUserText = (prompt: Prompt.Prompt): string => {
  const m = prompt.content.find((m) => m.role === "user")
  return m ? messageText(m) : ""
}
const lastToolResult = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((m) => (m.role === "tool" ? m.content.flatMap((p: any) => (p.type === "tool-result" ? [String(p.result)] : [])) : []))
    .at(-1) ?? ""
const toolCall = (id: string, script: string): Stream.Stream<Response.StreamPartEncoded> =>
  Stream.make({ type: "tool-call", id, name: "execute", params: { script } } as any)

const program = Effect.gen(function* () {
  const executor = yield* AgentExecutor.AgentExecutor
  const counts = { root: 0, child: 0 }
  const languageModel = yield* LanguageModel.make({
    generateText: () => Effect.die("unexpected generateText call"),
    streamText: (providerOptions) => {
      const role = firstUserText(providerOptions.prompt).includes("TASK-CHILD") ? "child" : "root"
      const index = counts[role]++
      say(`model call role=${role} index=${index}`)
      if (role === "root") {
        if (index === 0) {
          return toolCall(
            "r0",
            `const own = await bash({ command: 'echo "root sees [$CHAD_SESSION]"' })
console.log(own.output)
const r = await subagent({ prompt: "TASK-CHILD report your session" })
console.log("child result:", r.output)`
          )
        }
        return toolCall("r1", `await taskComplete(${JSON.stringify(lastToolResult(providerOptions.prompt))})`)
      }
      if (index === 0) {
        return toolCall(
          "c0",
          `const t = await bash({ command: 'echo "child sees [$CHAD_SESSION] nvars=$(env | grep -c .)"' })
console.log(t.output)`
        )
      }
      return toolCall("c1", `await taskComplete(${JSON.stringify(lastToolResult(providerOptions.prompt).trim())})`)
    }
  })
  const modelLayer = Layer.mergeAll(
    Layer.succeed(LanguageModel.LanguageModel, languageModel),
    Layer.succeed(Model.ProviderName, "test-provider"),
    Layer.succeed(Model.ModelName, "test-model")
  )
  const agent = yield* Agent.make.pipe(Effect.provideService(AgentExecutor.AgentExecutor, executor))
  const exit = yield* agent.send({ prompt: "hello" }).pipe(
    Effect.flatMap((stream) =>
      stream.pipe(
        Stream.runDrain,
        Effect.as("(no summary)"),
        Effect.catchTag("AgentFinished", (finished: any) => Effect.succeed(finished.summary as string))
      )
    ),
    Effect.provide(Layer.mergeAll(modelLayer, Agent.ConversationMode.layer(false), Agent.layerSubagentModel(modelLayer))),
    Effect.exit
  )
  say("ROOT EXIT: " + JSON.stringify(exit))
}).pipe(
  Effect.scoped,
  Effect.timeout("20 seconds"),
  Effect.provide(
    AgentExecutor.layerLocal({ directory: fs.mkdtempSync(path.join(os.tmpdir(), "chad-gs-")) }).pipe(
      Layer.provide(layerSessionSpawner("sess-PARENT", { log: say })),
      Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
    )
  )
)

NodeRuntime.runMain(program as any)
