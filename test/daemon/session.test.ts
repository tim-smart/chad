import { Effect } from "effect"
import { ChatError, ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import { owner, scenario } from "../support/driver.ts"
import {
  lines,
  posted,
  prompted,
  says,
  sessions,
  threadOf,
} from "../support/owner.ts"

test("a mention in a plain channel opens a thread that is the session, a message without one is ignored there, and the thread and a DM then need none", async () => {
  const running = await scenario({ env: { CHAD_LOG_LEVEL: "debug" } })
  const { fakes, chat } = running
  await fakes.model.script(["one", "two", "three"].map((text) => ({ text })))
  const channel = await fakes.chat.makeThread("channel")

  await says(running, channel, "hello")
  const ignored = await running.logged(
    "message.ignored",
    (line) => line.annotations["reason"] === "not-mentioned",
  )
  expect(ignored.annotations["author"]).toBe(owner)
  expect(sessions(running)).toEqual([])

  const mention = await says(running, channel, "hello", { mention: true })
  await running.logged("turn.ended")
  const [session] = sessions(running)
  const thread = threadOf(session)
  expect(thread).not.toEqual(channel)
  // The row holds the thread string of effect/chat, and the kind of the thread and not of the event.
  expect(session).toMatchObject({
    thread: ChatThread.toString(thread),
    kind: "thread",
  })
  expect(mention.kind).toBe("channel")
  expect(await posted(running, thread)).toEqual(["one"])
  expect(await posted(running, channel)).toEqual([])
  const opened = (await Effect.runPromise(chat.calls)).filter(
    (call) => call.op === "startThread",
  )
  expect(opened.map((call) => [call.thread, call.messageId])).toEqual([
    [channel, mention.message.id],
  ])

  // The same event again lands on the same thread, and starts nothing.
  expect(await fakes.chat.deliver(mention)).toBe(true)
  await running.logged(
    "message.ignored",
    (line) => line.annotations["reason"] === "duplicate",
  )
  expect(sessions(running)).toHaveLength(1)

  // The thread has a session now, so a message in it needs no mention.
  await says(running, thread, "and again")
  await fakes.chat.answers(thread, 2)
  expect(sessions(running)).toHaveLength(1)

  const direct = await fakes.chat.makeThread("direct")
  await says(running, direct, "hello")
  await fakes.chat.answers(direct, 1)
  expect(sessions(running)[1]).toMatchObject({
    thread: ChatThread.toString(direct),
    kind: "direct",
  })
})

test("the first message in an existing thread that has no session needs a mention, and with one the session is that thread itself", async () => {
  const running = await scenario({ env: { CHAD_LOG_LEVEL: "debug" } })
  const { fakes, chat } = running
  await fakes.model.script([{ text: "one" }])
  const thread = await fakes.chat.makeThread("thread")

  await says(running, thread, "hello")
  await running.logged(
    "message.ignored",
    (line) => line.annotations["reason"] === "not-mentioned",
  )
  expect(sessions(running)).toEqual([])

  await says(running, thread, "hello", { mention: true })
  await fakes.chat.answers(thread, 1)
  expect(sessions(running).map(threadOf)).toEqual([thread])
  const calls = await Effect.runPromise(chat.calls)
  expect(calls.filter((call) => call.op === "startThread")).toEqual([])
})

test("when the thread cannot be opened chad says so in the channel as a normal message with the platform's reason, and drops the event", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([])
  const channel = await fakes.chat.makeThread("channel")
  await Effect.runPromise(
    chat.failNext(
      "startThread",
      new ChatError.Forbidden({ detail: "Missing Permissions" }),
    ),
  )

  await says(running, channel, "hello", { mention: true })
  expect(await posted(running, channel)).toEqual([
    Messages.threadFailed("Missing Permissions"),
  ])
  expect(sessions(running)).toEqual([])
  expect(await fakes.model.calls()).toEqual([])
})

test("a chat command is the first word after the mention, in any case and with any text after it, it never reaches the model, and every other text does", async () => {
  const running = await scenario()
  const { fakes } = running
  const others = ["/revert", "/login", "/logout", "/logs", "please /stop"]
  await fakes.model.script([
    { text: "first" },
    ...others.map(() => ({ text: "ok" })),
  ])
  const thread = await fakes.chat.makeThread("thread")
  await says(running, thread, "hello", { mention: true })
  await fakes.chat.answers(thread, 1)

  await says(running, thread, "/STOP please")
  await says(running, thread, "  /Status now", { mention: true })
  await says(running, thread, "/new and forget it", { mention: true })
  await running.logged("command.ran")
  expect(await fakes.model.calls()).toHaveLength(1)

  for (const [index, text] of others.entries()) {
    await says(running, thread, text)
    const calls = await fakes.model.received(index + 2)
    expect(prompted(calls.at(-1))).toBe(text)
    await lines(running, "turn.ended", index + 2)
  }
  const said = await posted(running, thread)
  expect(said).toContain(Messages.nothingRunning(Format.local))
  expect(said).toContain(Messages.newSession(Format.local))
})

test("with nothing running /stop posts its notice and creates no session, and /new creates the thread's first session and posts its notice", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([])
  const direct = await fakes.chat.makeThread("direct")

  await says(running, direct, "/stop")
  expect(await posted(running, direct)).toEqual([
    Messages.nothingRunning(Format.local),
  ])
  expect(sessions(running)).toEqual([])

  const command = await says(running, direct, "/new")
  await fakes.chat.answers(direct, 2)
  expect(await posted(running, direct)).toEqual([
    Messages.nothingRunning(Format.local),
    Messages.newSession(Format.local),
  ])
  expect(sessions(running)).toMatchObject([
    {
      thread: ChatThread.toString(direct),
      kind: "direct",
      ended_at: null,
      last_message_id: command.message.id,
    },
  ])
  expect(await fakes.model.calls()).toEqual([])
})

test("a mentioned command in a plain channel with no session is answered in the channel, opens no thread and creates nothing", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([])
  const channel = await fakes.chat.makeThread("channel")

  await says(running, channel, "/new", { mention: true })
  await says(running, channel, "/stop", { mention: true })
  await says(running, channel, "/status", { mention: true })
  const said = await posted(running, channel)
  expect(said.slice(0, 2)).toEqual([
    Messages.noSession(Format.local),
    Messages.noSession(Format.local),
  ])
  expect(said[2]).toContain("daemon: up (ready)")
  expect(sessions(running)).toEqual([])
  const calls = await Effect.runPromise(chat.calls)
  expect(calls.filter((call) => call.op === "startThread")).toEqual([])
  expect(await fakes.model.calls()).toEqual([])
})

test("every message chad drops writes message.ignored with its reason and the author's id, and never the content: a stranger's, chad's own, one with no mention and a second delivery", async () => {
  const running = await scenario({ env: { CHAD_LOG_LEVEL: "debug" } })
  const { fakes } = running
  await fakes.model.script([{ text: "one" }])
  const channel = await fakes.chat.makeThread("channel")
  const direct = await fakes.chat.makeThread("direct")
  const reasons = () =>
    running
      .log()
      .filter((line) => line.annotations["event"] === "message.ignored")
      .map((line) => [line.annotations["reason"], line.annotations["author"]])

  const stranger = await fakes.chat.userPosts(direct, {
    text: "open sesame one",
    authorId: "stranger",
  })
  expect(await fakes.chat.deliver(stranger)).toBe(true)
  const mine = await fakes.chat.userPosts(direct, {
    text: "open sesame two",
    authorId: "chad-bot",
  })
  if (mine._tag !== "MessageCreated") throw new Error("not a message")
  // The event is made by hand, because ChatTest marks none of a user's messages as chad's own.
  expect(
    await fakes.chat.deliver({
      ...mine,
      message: {
        ...mine.message,
        author: { ...mine.message.author, isSelf: true },
      },
    }),
  ).toBe(true)
  await says(running, channel, "open sesame three")
  const hello = await says(running, direct, "open sesame four")
  await fakes.chat.answers(direct, 1)
  expect(await fakes.chat.deliver(hello)).toBe(true)
  await lines(running, "message.ignored", 4)

  expect(reasons()).toEqual([
    ["not-owner", "stranger"],
    ["own", "chad-bot"],
    ["not-mentioned", owner],
    ["duplicate", owner],
  ])
  const ignored = running
    .log()
    .filter((line) => line.annotations["event"] === "message.ignored")
  expect(JSON.stringify(ignored)).not.toContain("open sesame")
  // Only the stranger's line is above debug.
  expect(ignored.map((line) => line.level)).toEqual([
    "INFO",
    "DEBUG",
    "DEBUG",
    "DEBUG",
  ])
  expect(await fakes.model.calls()).toHaveLength(1)
})

test("/status posts the text of chad status, from the same daemon call, and the model is never asked", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([])
  const direct = await fakes.chat.makeThread("direct")
  await running.logged("boot.ready")
  await says(running, direct, "/status")
  const status = await running.chad(["status"])
  expect(status.code).toBe(0)
  expect(await posted(running, direct)).toEqual([
    Messages.status(status.stdout.trimEnd()),
  ])
  expect(await fakes.model.calls()).toEqual([])
  expect(sessions(running)).toEqual([])
})
