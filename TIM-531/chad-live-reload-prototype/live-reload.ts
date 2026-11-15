// PROTOTYPE for "Applying a plugin change to a live session" (TIM-531).
// Throwaway. Runs real turns against clanka 0.27.0 through the openai-compat
// provider. Run: CLANKA_OPENAI_API_URL=... CLANKA_OPENAI_API_KEY=... node live-reload.ts
//
// One session, nine turns:
//   1-3  Agent A (rollDice)              baseline, a long read, the cache inside one Agent
//   4    chunk changes                   frozen system prompt + an update message
//   5-6  tool added, Agent rebuilt       system prompt rebuilt, history carried over
//   7    tool added, prompt kept frozen  new tool declared in an update message only
//   8-9  background bash task            what the rebuilt Agent can still see of it
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Agent, AgentExecutor } from "clanka"
import * as OpenAiCompat from "clanka/OpenAiCompat"
import { ToolkitRenderer } from "clanka/ToolkitRenderer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const modelName = process.env.PROTO_MODEL ?? "gpt-5.6-luna"
const cacheKey = process.env.PROTO_CACHE_KEY // one per session, when set
const scratch = mkdtempSync(join(tmpdir(), "chad-proto-"))
// Something long to read, so the history outweighs the system prompt.
writeFileSync(
  join(scratch, "notes.txt"),
  Array.from({ length: 260 }, (_, i) => "Note " + (i + 1) + ": on day " + (i + 1) + " the owner logged " + ((i * 37) % 91) + " km and " + ((i * 53) % 17) + " coffees.").join("\n")
)

// --- Tools three "plugins" contribute. Handlers record that they ran. -------

const called: Array<string> = []

const Dice = Toolkit.make(
  Tool.make("rollDice", {
    description: "Roll one die and return the face it lands on.",
    parameters: Schema.Struct({ sides: Schema.Int }),
    success: Schema.Struct({ rolled: Schema.Int })
  })
)
const DiceLive = Dice.toLayer({
  rollDice: ({ sides }) => Effect.sync(() => (called.push("rollDice"), { rolled: Math.min(17, sides) }))
})

const Coin = Toolkit.make(
  Tool.make("flipCoin", {
    description: "Flip a coin.",
    success: Schema.Struct({ side: Schema.Literals(["heads", "tails"]) })
  })
)
const CoinLive = Coin.toLayer({
  flipCoin: () => Effect.sync(() => (called.push("flipCoin"), { side: "heads" as const }))
})

const Words = Toolkit.make(
  Tool.make("lookupWord", {
    description: "Look a word up in the owner's private glossary.",
    parameters: Schema.Struct({ word: Schema.String }),
    success: Schema.Struct({ meaning: Schema.String })
  })
)
const WordsLive = Words.toLayer({
  lookupWord: ({ word }) =>
    Effect.sync(() => (called.push("lookupWord"), { meaning: word + ": glossary entry 4471, a single-owner assistant" }))
})

// --- The session chad keeps. The Agent is replaceable, the rest is not. -----

interface Live {
  readonly agent: Agent.Agent
  readonly scope: Scope.Closeable
}
interface Session {
  live: Live
  chunks: Record<string, string>
  /** The system prompt this session last sent. Kept until a tool change. */
  frozenSystem: string | undefined
  /** Update messages waiting for the next turn. */
  pending: Array<string>
}

const renderSystem = (chunks: Record<string, string>) =>
(options: { readonly toolInstructions: string; readonly agentsMd: string }) =>
  "You are chad, Tim's personal assistant. Answer in one short sentence.\n\n" +
  options.toolInstructions + "\n\n# Plugin context\n\n" +
  Object.entries(chunks).map(([name, text]) => "## " + name + "\n\n" + text).join("\n\n") + "\n"

const update = (text: string) => "<environment-update>\n" + text + "\n</environment-update>"

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8)

const program = Effect.gen(function*() {
  const outer = yield* Effect.scope
  // One executor for the whole session. Its scope owns background bash tasks.
  const executorScope = yield* Scope.fork(outer)
  const executor = yield* Layer.buildWithScope(AgentExecutor.layerLocal({ directory: scratch }), executorScope)
  const renderer = yield* Effect.service(ToolkitRenderer).pipe(Effect.provide(ToolkitRenderer.layer))

  const build = Effect.fnUntraced(function*(toolkit: Toolkit.Any, handlers: Layer.Layer<any>) {
    const scope = yield* Scope.fork(outer)
    const context = yield* Layer.buildWithScope(handlers, scope)
    const agent = yield* Agent.makeWith({ loopTools: toolkit as any, skills: [], instructions: Option.none() }).pipe(
      Effect.provideContext(context),
      Effect.provideContext(executor),
      Scope.provide(scope)
    ) as Effect.Effect<Agent.Agent>
    return { agent, scope } satisfies Live
  })

  // The rebuild: new Agent, old history and environment, old Agent closed.
  const rebuild = Effect.fnUntraced(function*(session: Session, toolkit: Toolkit.Any, handlers: Layer.Layer<any>) {
    const next = yield* build(toolkit, handlers)
    MutableRef.set(next.agent.history, session.live.agent.history.current)
    MutableRef.set(next.agent.environment, session.live.agent.environment.current)
    yield* Scope.close(session.live.scope, Exit.void)
    session.live = next
  })

  let n = 0
  const turn = Effect.fnUntraced(function*(session: Session, note: string, text: string) {
    n++
    const before = called.length
    const updates = session.pending.splice(0)
    const frozen = session.frozenSystem
    let usage = { inputTokens: 0, cacheRead: 0, outputTokens: 0 }
    const perCall: Array<string> = []
    const scripts: Array<string> = []
    const outputs: Array<string> = []
    const stream = yield* session.live.agent.send({
      prompt: [...updates.map((content) => ({ role: "user" as const, content })), { role: "user" as const, content: text }],
      system: (options) => (session.frozenSystem = frozen ?? renderSystem(session.chunks)(options))
    })
    const answer = yield* stream.pipe(
      Stream.runForEach((part) =>
        Effect.sync(() => {
          if (part._tag === "Usage") {
            perCall.push((part.inputTokens - usage.inputTokens) + " in / " + (part.cacheRead - usage.cacheRead) + " cached")
            usage = part
          }
          if (part._tag === "ScriptDelta") scripts.push(part.delta)
          if (part._tag === "ScriptOutput") outputs.push(part.output)
        })
      ),
      Effect.as("(stream ended without an answer)"),
      Effect.catchTag("AgentFinished", (finished) => Effect.succeed(finished.summary))
    )
    const first = session.live.agent.history.current.content[0]
    const pct = usage.inputTokens === 0 ? 0 : Math.round((100 * usage.cacheRead) / usage.inputTokens)
    console.log("\n=== turn " + n + ": " + note)
    for (const u of updates) console.log("  update  " + u.replace(/\n/g, "\n          "))
    console.log("  user    " + text)
    for (const s of scripts) console.log("  script  " + s.trim().replace(/\n/g, "\n          "))
    for (const o of outputs) {
      const lines = o.trim().split("\n").filter((l) => !l.includes("INFO"))
      console.log("  output  " + (lines.length > 6 ? lines.slice(0, 2).join("\n          ") + "\n          ... " + (lines.length - 2) + " more lines" : lines.join("\n          ")))
    }
    console.log("  answer  " + answer.trim())
    console.log("  tools   " + (called.slice(before).join(", ") || "none"))
    console.log("  system  " + (first?.role === "system" ? sha(first.content) : "none") + (frozen ? " (frozen)" : " (rendered)"))
    console.log("  tokens  input " + usage.inputTokens + ", cached " + usage.cacheRead + " (" + pct + "%); per model call: " + perCall.join(", "))
  }, Effect.scoped)

  // ---------------------------------------------------------------------------
  const session: Session = {
    live: yield* build(Dice, DiceLive),
    chunks: { weather: "Today's weather: high 21°C, rain 0mm." },
    frozenSystem: undefined,
    pending: []
  }

  yield* turn(session, "Agent A, tools: rollDice", "Remember this codeword: PLATYPUS. Then roll a d20 and tell me what you got.")
  yield* turn(session, "same Agent, a long read to grow the history", "Print the whole of notes.txt with readFile, then tell me how many coffees note 200 has.")
  yield* turn(session, "same Agent, nothing changed", "What is today's high?")

  // A chunk changes. No rebuild. The system prompt stays frozen.
  session.chunks.weather = "Today's weather: high 30°C, rain 4mm."
  session.pending.push(update(
    "# Plugin context changed\n\nThe \"weather\" section of your instructions is replaced by:\n\n" + session.chunks.weather
  ))
  yield* turn(session, "chunk changed, system prompt frozen", "And what is today's high now?")

  // A tool is added. Rebuild, and let the system prompt be rendered again.
  yield* rebuild(session, Toolkit.merge(Dice, Coin), Layer.merge(DiceLive, CoinLive))
  session.frozenSystem = undefined
  yield* turn(session, "Agent B, tools: rollDice + flipCoin, system prompt rebuilt", "What was the codeword? Then flip a coin and tell me the side.")
  yield* turn(session, "same Agent, nothing changed", "Roll a d6.")

  // A tool is added, but the system prompt stays frozen. The declaration
  // reaches the model in an update message only. NOT what charting agreed.
  yield* rebuild(session, Toolkit.merge(Dice, Coin, Words), Layer.mergeAll(DiceLive, CoinLive, WordsLive))
  session.pending.push(update(
    "# Tools changed\n\nThis function is now available to your scripts, next to the ones in your instructions:\n\n" +
      "```ts\n" + renderer.render(Words) + "\n```"
  ))
  yield* turn(session, "Agent C, tools: + lookupWord, system prompt frozen", "Look up the word chad in my glossary.")

  // A background bash task, then a rebuild on the same executor.
  yield* turn(session, "Agent C starts a background task", "Start the command 'sleep 297' as a background bash task and reply with its task id only.")
  yield* rebuild(session, Toolkit.merge(Dice, Coin, Words), Layer.mergeAll(DiceLive, CoinLive, WordsLive))
  yield* turn(session, "Agent D, same tools, same executor", "Call listTasks() and tell me exactly what it returned.")

  const alive = () => {
    try {
      return execSync("pgrep -a -x sleep | grep -c ' 297$' || true").toString().trim() !== "0"
    } catch {
      return false
    }
  }
  console.log("\n'sleep 297' still running after the rebuild: " + alive())
  yield* Scope.close(executorScope, Exit.void)
  yield* Effect.sleep("1 second")
  console.log("'sleep 297' still running after the executor closed: " + alive())
})

const Model = OpenAiCompat.model(modelName, {
  reasoning: { effort: "low" },
  ...(cacheKey ? { prompt_cache_key: cacheKey } : {})
} as any).pipe(
  Layer.provide(OpenAiCompat.layerClient({
    apiKey: Redacted.make(process.env.CLANKA_OPENAI_API_KEY!),
    apiUrl: process.env.CLANKA_OPENAI_API_URL!
  }))
)

console.log("model " + modelName + ", prompt_cache_key " + (cacheKey ?? "not sent") + ", scratch " + scratch)
program.pipe(
  Effect.scoped,
  Effect.provide([Model, Agent.ConversationMode.layer(true)]),
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
  NodeRuntime.runMain
)
