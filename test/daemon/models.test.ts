import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import { query } from "../support/database.ts"
import * as Discord from "../support/discord.ts"
import { owner, type Scenario, scenario } from "../support/driver.ts"
import { tokenFileName } from "../support/model.ts"
import { eventually } from "../support/owner.ts"

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

test("SES-56 SES-96b MOD-2 MOD-27 MOD-29 MOD-31 MOD-32 MOD-66 MOD-67 MOD-68 MOD-111 TST-37 TST-38 a Codex turn refreshes the stored token first, the token file and its directory are private after it, the session's id is its prompt_cache_key and its session-id header, and no token reaches the log or status", async () => {
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

test("MOD-11 MOD-11b STO-142 a restart runs the model stored in state/model over CHAD_MODEL", async () => {
  const first = await scenario()
  await first.stop()
  const state = join(first.data, "state")
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, "model"), "openai-compat/stored\n")

  const running = await scenario({ directory: first.directory })
  const { fakes, data } = running
  await fakes.model.script([{ text: "ok" }])
  const thread = await fakes.chat.makeThread("direct")
  await ask(running, thread, "hello")
  await fakes.chat.answers(thread, 1)

  const [call] = await fakes.model.calls()
  expect(call?.body).toMatchObject({ model: "stored" })
  const [turn] = query(data, "SELECT model FROM turns")
  expect(turn?.["model"]).toBe("openai-compat/stored")
})

test("MOD-95 MOD-127 on Discord the check at start waits for the gateway session, and sends its request once READY has come", async () => {
  const running = await scenario({
    connections: [
      {
        name: "home",
        kind: "discord",
        token: "home-token",
        owners: ["700000000000000001"],
      },
    ],
  })
  const connected = () =>
    running
      .log()
      .filter((line) => line.annotations["event"] === "chat.connected")
  const socket = await running.discord.gateway.socket(0)
  socket.receive(Discord.hello)
  await socket.sent(Discord.Op.identify, 1)
  await running.logged("boot.ready")
  // The gateway holds READY back. The adapter has registered by now, and a round trip through the CLI gives a check
  // that went early the time to arrive.
  expect((await running.chad(["status"])).code).toBe(0)
  expect(running.model.checks()).toEqual([])
  expect(connected()).toEqual([])

  socket.receive(Discord.ready(1))
  await running.logged("chat.connected")
  await eventually(
    () => running.model.checks(),
    (checks) => checks.length === 1,
  )
})
