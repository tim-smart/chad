import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { scenario } from "../support/driver.ts"

const connection = (owners: ReadonlyArray<string>) => ({
  connections: [{ name: "local", kind: "local" as const, owners }],
})

test("TST-164 TST-201 OV-2 SES-6 DIS-6 DIS-111 FAIL-301 a message from an id that is not on the connection's list starts nothing, and its log line has the author and not the content", async () => {
  const running = await scenario(connection(["ada", "grace"]))
  const { fakes, data } = running
  await fakes.model.script([{ text: "Hello Grace." }])
  const thread = await fakes.chat.makeThread("direct")
  const stranger = await fakes.chat.userPosts(thread, {
    text: "open sesame",
    authorId: "mallory",
  })
  expect(await fakes.chat.deliver(stranger)).toBe(true)
  const ignored = await running.logged("message.ignored")
  const second = await fakes.chat.userPosts(thread, {
    text: "hello",
    authorId: "grace",
  })
  expect(await fakes.chat.deliver(second)).toBe(true)
  await fakes.chat.answers(thread, 1)

  // The owner's message made the only turn, and the stranger's words never reached the model.
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(1)
  expect(JSON.stringify(calls[0]?.body)).not.toContain("open sesame")
  expect(ignored.level).toBe("INFO")
  expect(ignored.annotations).toMatchObject({
    reason: "not-owner",
    author: "mallory",
  })
  expect(readFileSync(data + "/logs/chad.log", "utf8")).not.toContain(
    "open sesame",
  )
})

test("SES-122 DIS-80 TST-67 a message marked isSelf is dropped before the owner check, though its id is on the list", async () => {
  const running = await scenario({
    ...connection(["chad-bot"]),
    env: { CHAD_LOG_LEVEL: "debug" },
  })
  const { fakes } = running
  await fakes.model.script([{ text: "Hello." }])
  const thread = await fakes.chat.makeThread("direct")
  const posted = await fakes.chat.userPosts(thread, {
    text: "my own answer",
    authorId: "chad-bot",
  })
  if (posted._tag !== "MessageCreated") throw new Error("not a message")
  // The event is made by hand, because ChatTest marks none of a user's messages as chad's own.
  const own = {
    ...posted,
    message: {
      ...posted.message,
      author: { ...posted.message.author, isSelf: true },
    },
  }
  expect(await fakes.chat.deliver(own)).toBe(true)
  const ignored = await running.logged("message.ignored")
  expect(ignored.annotations).toMatchObject({
    reason: "own",
    author: "chad-bot",
  })

  // The same id without the mark is an owner, and its message makes the one turn.
  expect(await fakes.chat.deliver(posted)).toBe(true)
  await fakes.chat.answers(thread, 1)
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(1)
})

test("SES-123 TST-68 the list is by id alone, so a bot whose id is on it is an owner and a bot whose id is not is ignored", async () => {
  const running = await scenario(connection(["helper-bot"]))
  const { fakes } = running
  await fakes.model.script([{ text: "Hello bot." }])
  const thread = await fakes.chat.makeThread("direct")
  const other = await fakes.chat.userPosts(thread, {
    text: "beep",
    authorId: "other-bot",
    isBot: true,
  })
  expect(await fakes.chat.deliver(other)).toBe(true)
  const ignored = await running.logged("message.ignored")
  expect(ignored.annotations).toMatchObject({
    reason: "not-owner",
    author: "other-bot",
  })
  const listed = await fakes.chat.userPosts(thread, {
    text: "boop",
    authorId: "helper-bot",
    isBot: true,
  })
  expect(await fakes.chat.deliver(listed)).toBe(true)
  const [answer] = await fakes.chat.answers(thread, 1)
  expect(answer?.text).toBe("Hello bot.")
  expect(await fakes.model.calls()).toHaveLength(1)
})
