import { readFileSync } from "node:fs"
import { ChatThread } from "effect/chat"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { query } from "../support/database.ts"
import { owner, type Scenario, scenario } from "../support/driver.ts"

/** An owner's message, delivered to the daemon. */
const ask = async (
  { fakes }: Scenario,
  thread: ChatThread.ChatThread,
  text: string,
) => {
  const event = await fakes.chat.userPosts(thread, { text, authorId: owner })
  expect(await fakes.chat.deliver(event)).toBe(true)
  return event
}

test("TST-164 TST-203 TST-34 TST-35 MOD-4 MOD-8 MOD-11a MOD-73 a message in and a scripted answer out, on the openai-compat model the environment names", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "Hello from the script." }])
  const thread = await fakes.chat.makeThread("direct")
  await ask(running, thread, "hello")

  const [answer] = await fakes.chat.answers(thread, 1)
  expect(answer?.text).toBe("Hello from the script.")
  const [call] = await fakes.model.calls()
  expect(call?.path).toBe("/v1/chat/completions")
  expect(call?.headers["authorization"]).toBe("Bearer fake-key")
  expect(call?.body).toMatchObject({ model: "fake" })
  expect(JSON.stringify(call?.body)).toContain("hello")
  // The one request the daemon made went through the client it was given.
  expect(running.requests()).toHaveLength(1)
  expect(running.requests()[0]).toMatch(/\/v1\/chat\/completions$/)
})

test("MOD-98 an openai-compat request carries neither prompt_cache_key nor a session-id header", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "ok" }])
  const thread = await fakes.chat.makeThread("direct")
  await ask(running, thread, "hello")
  await fakes.chat.answers(thread, 1)

  const [call] = await fakes.model.calls()
  expect(call?.body).not.toHaveProperty("prompt_cache_key")
  expect(Object.keys(call?.headers ?? {})).not.toContain("session-id")
  expect(Object.keys(call?.headers ?? {})).not.toContain("session_id")
})

test("SES-17 SES-44 SES-50 DIS-7 DIS-11 DIS-50 TST-56 the entity posts the clean final answer once, as a normal post in the thread the message came from", async () => {
  const running = await scenario()
  const { fakes, chat, data } = running
  await fakes.model.script([{ text: "The **final** answer." }])
  const thread = await fakes.chat.makeThread("direct")
  await ask(running, thread, "hello")
  await fakes.chat.answers(thread, 1)

  // The driver holds ChatTest itself, so it reads the adapter's calls with no verb in the product.
  const calls = await Effect.runPromise(chat.calls)
  expect(calls.map((call) => [call.op, call.thread, call.markdown])).toEqual([
    ["post", thread, "The **final** answer."],
  ])
  // The turn ended at the text reply, with nothing waiting, so the model was asked once.
  expect(await fakes.model.calls()).toHaveLength(1)
  // The reply to the request is its outcome and not the answer.
  await running.stop()
  const replies = query(data, "SELECT payload FROM cluster_replies")
  expect(replies).toHaveLength(1)
  expect(String(replies[0]?.["payload"])).toContain("answered")
  expect(String(replies[0]?.["payload"])).not.toContain("final")
})

test("SES-1 SES-2 SES-13 SES-149 STO-194 each DM and each thread is one Session entity, keyed by the thread string, with a session id of its own", async () => {
  const running = await scenario()
  const { fakes, data } = running
  await fakes.model.script(
    ["one", "two", "three", "four"].map((text) => ({ text })),
  )
  const first = await fakes.chat.makeThread("direct")
  const second = await fakes.chat.makeThread("direct")
  const third = await fakes.chat.makeThread("thread")
  for (const thread of [first, second, third]) {
    await ask(running, thread, "hello")
    await fakes.chat.answers(thread, 1)
  }
  // A second message in a thread belongs to the session the thread already has.
  await ask(running, third, "again")
  await fakes.chat.answers(third, 2)

  await running.stop()
  const threads = [first, second, third].map(ChatThread.toString)
  const sessions = query(data, "SELECT id, thread FROM sessions ORDER BY rowid")
  expect(sessions.map((session) => session["thread"])).toEqual(threads)
  for (const session of sessions) {
    expect(session["id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  }
  expect(new Set(sessions.map((session) => session["id"])).size).toBe(3)
  const requests = query(
    data,
    "SELECT entity_type, entity_id FROM cluster_messages ORDER BY id",
  )
  expect(requests.map((request) => request["entity_type"])).toEqual(
    Array(4).fill("Session"),
  )
  expect(requests.map((request) => request["entity_id"])).toEqual([
    ...threads,
    threads[2],
  ])
})

test("SES-14 SES-33 SES-151 an owner message is a persisted request keyed by the event's dedupe key, and a second delivery starts no second turn", async () => {
  const running = await scenario()
  const { fakes, data } = running
  await fakes.model.script([{ text: "first" }, { text: "second" }])
  const thread = await fakes.chat.makeThread("direct")
  const event = await ask(running, thread, "hello")
  expect(await fakes.chat.deliver(event)).toBe(true)
  await fakes.chat.answers(thread, 1)
  await ask(running, thread, "and again")
  await fakes.chat.answers(thread, 2)

  // Two messages made two turns, though three events were delivered.
  expect(await fakes.model.calls()).toHaveLength(2)
  await running.stop()
  const requests = query(
    data,
    "SELECT message_id, payload FROM cluster_messages ORDER BY id",
  )
  expect(requests).toHaveLength(2)
  if (event._tag !== "MessageCreated") throw new Error("not a message")
  expect(String(requests[0]?.["message_id"])).toContain(event.message.id)
  // The request holds the whole message in effect/chat's encoded form, and the attachment ids.
  const payload = JSON.parse(String(requests[0]?.["payload"]))
  expect(payload.message).toMatchObject({
    id: event.message.id,
    text: "hello",
    author: { id: owner, isSelf: false },
  })
  expect(payload.attachments).toEqual([])
})

test("TST-36 a script holds a response until the scenario releases it", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "held", hold: true }])
  const thread = await fakes.chat.makeThread("direct")
  await ask(running, thread, "hello")

  await fakes.model.received(1)
  const before = await fakes.chat.messages(thread)
  expect(before.filter((message) => message.author.isSelf)).toEqual([])
  await fakes.model.release(0)
  const [answer] = await fakes.chat.answers(thread, 1)
  expect(answer?.text).toBe("held")
})

test("TST-26 TST-31 TST-32 IMG-114 runDaemon owns the signals, the exit code and CHAD_SESSION=daemon, in the test's own process", async () => {
  const handlers = process.listenerCount("SIGTERM")
  const running = await scenario()
  await running.logged("boot.ready")
  expect(process.env["CHAD_SESSION"]).toBe("daemon")
  expect(process.listenerCount("SIGTERM")).toBe(handlers + 1)

  expect(await running.stop()).toBe(0)
  expect(process.env["CHAD_SESSION"]).toBeUndefined()
  expect(process.listenerCount("SIGTERM")).toBe(handlers)

  // `chad serve` and the test entry are a few lines each, and both call it.
  for (const file of ["src/daemon.ts", "test/support/entry.ts"]) {
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("//"))
    expect(lines.join("\n")).toContain("runDaemon(")
    expect(lines.length).toBeLessThanOrEqual(15)
  }
})

test("TST-46 TST-47 LOAD-2 STO-29 the running daemon is the built package, with one copy of chad and of effect, on node:sqlite", async () => {
  const running = await scenario()
  await running.logged("boot.ready")

  const resolved = [...globalThis.chadResolved]
  const copies = (file: RegExp) =>
    new Set(resolved.filter((url) => file.test(url))).size
  expect(copies(/\/node_modules\/effect\/dist\/index\.js$/)).toBe(1)
  expect(copies(/\/daemon\/runDaemon\.[jt]s$/)).toBe(1)
  expect(copies(/\/dist\/daemon\/runDaemon\.js$/)).toBe(1)
  expect(copies(/\/Timings\.[jt]s$/)).toBe(1)
  expect(resolved).toContain("node:sqlite")
  expect(resolved.filter((url) => /better-sqlite3/.test(url))).toEqual([])
})

test("TST-203 two daemons, one after another in one process, each read their own data path, and a chad command's environment has no CHAD_SESSION", async () => {
  const first = await scenario()
  const started = await first.logged("boot.started")
  expect(started.annotations["data"]).toBe(first.data)
  expect(process.env["CHAD_SESSION"]).toBe("daemon")
  expect(first.environment()["CHAD_SESSION"]).toBeUndefined()
  // The driver's values are in the environment only while the daemon reads them.
  expect(process.env["CHAD_DATA"]).toBeUndefined()
  await first.stop()

  const second = await scenario()
  const again = await second.logged("boot.started")
  expect(again.annotations["data"]).toBe(second.data)
  expect(second.data).not.toBe(first.data)
})

test("FAIL-4 FAIL-5 FAIL-6 a line of chad's own has one message, the fixed annotation keys and no span", async () => {
  // With no model set the turn fails, which is the one line of this slice that belongs to a session.
  const running = await scenario({ env: { CHAD_MODEL: undefined } })
  const { fakes, data } = running
  const thread = await fakes.chat.makeThread("direct")
  await ask(running, thread, "hello")

  const failed = await running.logged("turn.failed")
  await running.stop()
  const [session] = query(data, "SELECT id FROM sessions")
  expect(failed.annotations["session"]).toBe(session?.["id"])
  const raw = readFileSync(data + "/logs/chad.log", "utf8")
    .trim()
    .split("\n")
  for (const line of raw.map((line) => JSON.parse(line))) {
    if (line.annotations.event === undefined) continue
    expect(typeof line.message).toBe("string")
    expect(line.spans).toEqual({})
  }
})
