// The persona as the owner and the agent reach it: `persona.md` goes into each session's system prompt once it is
// applied, at the session's next turn, after chad's core block and before the plugins' chunks, and safe mode leaves it
// out.
import { join } from "node:path"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import { write } from "../support/applied.ts"
import { scenario, type Scenario } from "../support/driver.ts"
import type { Call } from "../support/model.ts"
import type { ChatThread } from "effect/chat"
import { lines, says } from "../support/owner.ts"

/** The system prompt a model call sends. */
const systemText = (call: Call | undefined) =>
  (
    (
      call?.body as {
        messages?: ReadonlyArray<{ role?: string; content?: unknown }>
      }
    )?.messages ?? []
  )
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
    .join("\n")

const core = "You are a world-class software engineer"
const chunk = "notes chunk text"
const persona = "You are Tim's butler. The vault is mounted at /mnt/vault."

/** One owner turn in the thread, and the system prompt its model call sent. */
const turn = async (
  running: Scenario,
  thread: ChatThread.ChatThread,
  text: string,
) => {
  const ended = running
    .log()
    .filter((line) => line.annotations["event"] === "turn.ended").length
  await running.fakes.model.script([{ text: "ok" }])
  await says(running, thread, text)
  await lines(running, "turn.ended", ended + 1)
  return systemText((await running.fakes.model.calls())[0])
}

test("the applied persona.md reaches an open session's prompt at its next turn, after the core block and before the chunks, a draft in work/ does not, and safe mode leaves it out", async () => {
  const notes = Plugin.make(Plugin.prompt(() => Effect.succeed(chunk)))
  const running = await scenario({
    plugins: [{ name: "notes", plugin: notes }],
  })
  const work = join(running.data, "repo/work")
  const thread = await running.fakes.chat.makeThread("direct")

  // The first commit's persona.md is empty, which adds nothing to the prompt.
  const empty = await turn(running, thread, "hello")
  expect(empty).toContain(chunk)
  expect(empty).not.toContain("## Persona")

  // A persona in work/ is a draft until it is applied.
  write(work, { "persona.md": `\n${persona}\n\n` })
  expect(await turn(running, thread, "a draft")).not.toContain(persona)

  // Applied, it reaches the open session at its next turn, after the core block and before the chunk.
  expect((await running.chad(["apply", "-m", "Persona"])).code).toBe(0)
  const applied = await turn(running, thread, "applied")
  expect(applied).toContain(`## Persona\n\n${persona}\n`)
  expect(applied.indexOf(core)).toBe(0)
  expect(applied.indexOf(persona)).toBeLessThan(applied.indexOf(chunk))

  // Safe mode leaves it out, and it is back once safe mode is off.
  expect((await running.chad(["safe", "on"])).code).toBe(0)
  const safe = await turn(running, thread, "in safe mode")
  expect(safe).toContain(Messages.safePrompt)
  expect(safe).not.toContain(persona)
  expect((await running.chad(["safe", "off"])).code).toBe(0)
  expect(await turn(running, thread, "safe mode is off")).toContain(persona)
})
