import { Effect } from "effect"
import { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import { owner, scenario } from "../support/driver.ts"
import { lines, posted, says, sessions, threadOf } from "../support/owner.ts"

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
