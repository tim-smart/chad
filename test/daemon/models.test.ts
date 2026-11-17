import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import { query } from "../support/database.ts"
import { owner, type Scenario, scenario } from "../support/driver.ts"
import { tokenFileName } from "../support/model.ts"

/** An owner's message, delivered to the daemon. */
const ask = async (
  { fakes }: Scenario,
  thread: ChatThread.ChatThread,
  text: string,
) => {
  const event = await fakes.chat.userPosts(thread, { text, authorId: owner })
  expect(await fakes.chat.deliver(event)).toBe(true)
}

/** The mode bits of a file. */
const mode = (path: string) => statSync(path).mode & 0o777

test("a Codex turn refreshes the stored token first, the token file and its directory are private after it, the session's id is its prompt_cache_key and its session-id header, and no token reaches the log or status", async () => {
  const running = await scenario({
    codex: "expired",
    env: {
      CHAD_MODEL: "openai/gpt-6-astra/medium",
      CHAD_OPENAI_API_KEY: undefined,
    },
  })
  const { fakes, data, model } = running
  const seeded = running.token!
  await fakes.model.script([{ text: "Hello over Codex." }])
  const thread = await fakes.chat.makeThread("direct")
  await ask(running, thread, "hello")

  const [answer] = await fakes.chat.answers(thread, 1)
  expect(answer?.text).toBe("Hello over Codex.")
  // The turn asked the login for a token before it built its model, and the expired one was refreshed.
  expect(model.refreshed()).toEqual([seeded.refresh])
  const directory = join(data, "secrets", "auth")
  const file = join(directory, tokenFileName)
  const stored = JSON.parse(readFileSync(file, "utf8")) as {
    access: string
    refresh: string
  }
  expect(stored.access).not.toBe(seeded.access)
  expect(mode(directory)).toBe(0o700)
  expect(mode(file)).toBe(0o600)

  const [session] = query(data, "SELECT id FROM sessions")
  const id = String(session?.["id"])
  const [call] = await fakes.model.calls()
  expect(call?.path).toBe("/codex/responses")
  expect(call?.headers["authorization"]).toBe(`Bearer ${stored.access}`)
  expect(call?.headers["session-id"]).toBe(id)
  expect(call?.body).toMatchObject({
    model: "gpt-6-astra",
    prompt_cache_key: id,
  })
  const [turn] = query(data, "SELECT model FROM turns")
  expect(turn?.["model"]).toBe("openai/gpt-6-astra/medium")

  const status = await running.chad(["status"])
  await running.stop()
  const log = readFileSync(join(data, "logs", "chad.log"), "utf8")
  for (const secret of [
    seeded.access,
    seeded.refresh,
    stored.access,
    stored.refresh,
  ]) {
    expect(log).not.toContain(secret)
    expect(status.stdout + status.stderr).not.toContain(secret)
  }
})
