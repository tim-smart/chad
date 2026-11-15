import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as OpenAiCompat from "clanka/OpenAiCompat"
import { Effect, Fiber, Layer, Stream } from "effect"
import type { Prompt } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { expect, it, onTestFinished } from "vitest"
import * as Attachments from "../../src/daemon/Attachments.ts"
import * as Handler from "../../src/daemon/Handler.ts"
import * as Sessions from "../../src/daemon/Sessions.ts"
import * as Format from "../../src/daemon/Format.ts"
import * as Messages from "../../src/Messages.ts"
import * as FakeModel from "../support/model.ts"

/** A message with a mention of chad in front of its text. */
const mentioned = (text: string) => ({
  text: `<@chad> ${text}`,
  mentions: [
    { kind: "user" as const, id: "chad", isSelf: true, start: 0, end: 7 },
  ],
})

it("SES-34 SES-145 SES-146 a chat command is the first word of the trimmed message once the mention of chad is taken out, in any case and with any text after it, and nothing else is one", () => {
  const plain = (text: string) => Handler.command({ text, mentions: [] })
  expect(plain("/new")).toBe("new")
  expect(plain("  /STOP please, now")).toBe("stop")
  expect(plain("/Status\nand more")).toBe("status")
  expect(Handler.command(mentioned("/new"))).toBe("new")
  expect(Handler.command(mentioned("  /stop it"))).toBe("stop")
  for (const text of [
    "please /stop",
    "/stopped",
    "new",
    "/revert",
    "/login",
    "/",
    "",
  ]) {
    expect(plain(text)).toBeUndefined()
  }
  // A mention of someone else is not taken out, so the command is not the first word.
  expect(
    Handler.command({
      text: "<@other> /stop",
      mentions: [
        { kind: "user", id: "other", isSelf: false, start: 0, end: 8 },
      ],
    }),
  ).toBeUndefined()
})

it("STO-204 an inbox file is named by the message's id and the file's own name, with every character that is not a letter, a digit, a dot, an underscore or a hyphen as an underscore, no leading dots, and file for a name with nothing left", () => {
  expect(Attachments.inboxName("m1", "notes.txt")).toBe("m1-notes.txt")
  expect(Attachments.inboxName("m1", "my notes (1)?.txt")).toBe(
    "m1-my_notes__1__.txt",
  )
  expect(Attachments.inboxName("m1", "../../etc/passwd")).toBe(
    "m1-_.._etc_passwd",
  )
  expect(Attachments.inboxName("m1", "...hidden")).toBe("m1-hidden")
  expect(Attachments.inboxName("m1", "...")).toBe("m1-file")
  expect(Attachments.inboxName("m1", "")).toBe("m1-file")
  expect(Attachments.inboxName("m1", undefined)).toBe("m1-file")
  expect(Attachments.inboxName("a/b", "x")).toBe("a_b-x")
})

it("STO-206 a turn id is t_ and twelve lowercase hexadecimal digits, and no two are the same", () => {
  const ids = Array.from({ length: 200 }, Sessions.turnId)
  for (const id of ids) expect(id).toMatch(/^t_[0-9a-f]{12}$/)
  expect(new Set(ids).size).toBe(200)
})

it("SES-191 the image limit is 10 MiB and the file limit 25 MiB", () => {
  expect(Attachments.imageLimit).toBe(10 * 1024 * 1024)
  expect(Attachments.fileLimit).toBe(25 * 1024 * 1024)
})

it("SES-195 the reconcile gives each outstanding steer, oldest first, the first message it wrote with that text after the message the steer before it took, and a steer with no such message none", () => {
  // Every steer is among what was written, in order.
  expect(Sessions.matched(["a", "b"], ["a", "b"])).toEqual([0, 1])
  // Other messages lie between them, and a message with other content has no text.
  expect(Sessions.matched(["a", "b"], [undefined, "a", "x", "b"])).toEqual([
    0, 1,
  ])
  // Two steers with one text take one message each.
  expect(Sessions.matched(["a", "a"], ["a", "a"])).toEqual([0, 1])
  expect(Sessions.matched(["a", "a"], ["a"])).toEqual([0])
  // The order holds: a message before the one an older steer took is not a newer steer's.
  expect(Sessions.matched(["a", "b"], ["b", "a"])).toEqual([0])
  // A steer the Agent never read has no message, and the ones after it can still have theirs.
  expect(Sessions.matched(["a", "b"], ["b"])).toEqual([1])
  expect(Sessions.matched(["a"], [])).toEqual([])
  expect(Sessions.matched([], ["a"])).toEqual([])
})

it("DIS-59 DIS-64 DIS-75 DIS-76 DIS-77 SES-186 SES-190 the notices of a session are templates of the Messages module in the spec's wording, as subtext, and the one about a thread is a normal message", () => {
  expect(Messages.stopped(Format.discord, 48_000)).toBe("-# Stopped after 48s.")
  expect(Messages.stopped(Format.discord, 125_400)).toBe(
    "-# Stopped after 2m 5s.",
  )
  expect(Messages.stopped(Format.discord, 200)).toBe("-# Stopped after 0s.")
  expect(Messages.nothingRunning(Format.discord)).toBe("-# Nothing is running.")
  expect(Messages.newSession(Format.discord)).toBe(
    "-# New session started. Nothing from the earlier conversation carries over.",
  )
  expect(Messages.noSession(Format.discord)).toBe(
    "-# There is no session in this channel. Mention me with a message and I'll open a thread for it.",
  )
  expect(Messages.threadFailed("Missing Permissions")).toBe(
    "I couldn't open a thread on that message (Missing Permissions). I need Create Public Threads here, or you can DM me.",
  )
  expect(
    Messages.fileSkipped(Format.discord, "big.zip", 48 * 1024 * 1024),
  ).toBe("-# Skipped `big.zip` (48 MB). The limit is 25 MB.")
  expect(Messages.fileFailed(Format.discord, "lost.txt")).toBe(
    "-# Skipped `lost.txt`. I couldn't download it.",
  )
})

it("SES-196 a mark is later than another by its time, and at one time by its id: a longer id is later, and ids of one length compare as text", () => {
  const at = 1_700_000_000_000
  expect(Sessions.later({ id: "m1", at: at + 1 }, { id: "m9", at })).toBe(true)
  expect(Sessions.later({ id: "m9", at }, { id: "m1", at: at + 1 })).toBe(false)
  expect(Sessions.later({ id: "m4", at }, { id: "m3", at })).toBe(true)
  expect(Sessions.later({ id: "m10", at }, { id: "m9", at })).toBe(true)
  expect(Sessions.later({ id: "m9", at }, { id: "m10", at })).toBe(false)
  // Discord's ids are decimal numbers.
  expect(
    Sessions.later(
      { id: "1200000000000000001", at },
      { id: "999999999999999999", at },
    ),
  ).toBe(true)
  expect(Sessions.later({ id: "m3", at }, { id: "m3", at })).toBe(false)
})

it("SES-176 the pinned clanka takes the two steers that wait while a model call runs in one step: one HistoryAppended batch of their user messages, in the order of the calls", async () => {
  const model = await FakeModel.start()
  onTestFinished(() => model.close())
  const directory = mkdtempSync(join(tmpdir(), "steer-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  model.script([
    { ...FakeModel.runs('console.log("ran")'), hold: true },
    { text: "done" },
  ])
  const services = Layer.mergeAll(
    AgentExecutor.layerLocal({ directory }),
    OpenAiCompat.model("fake").pipe(
      Layer.provide(OpenAiCompat.layerClient({ apiUrl: model.url })),
    ),
    Agent.ConversationMode.layer(true),
  ).pipe(
    Layer.provideMerge(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
  )

  const batches = await Effect.gen(function* () {
    const agent = yield* Agent.make
    const output = yield* agent.send({ prompt: "hello" })
    const batches: Array<ReadonlyArray<Prompt.Message>> = []
    // The stream ends with AgentFinished once the turn is over.
    const parts = yield* Stream.runForEach(output, (part) =>
      Effect.sync(() => {
        if (part._tag === "HistoryAppended") batches.push(part.messages)
      }),
    ).pipe(
      Effect.catchTag("AgentFinished", () => Effect.void),
      Effect.forkScoped,
    )
    yield* Effect.promise(() => model.received(1))
    const first = yield* Effect.forkScoped(agent.steer("first"))
    const second = yield* Effect.forkScoped(agent.steer("second"))
    yield* Effect.yieldNow
    model.release(0)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    yield* Fiber.join(parts)
    return batches
  }).pipe(Effect.scoped, Effect.provide(services), Effect.runPromise)

  const steered = batches.filter((batch) =>
    batch.some((message) => JSON.stringify(message).includes("first")),
  )
  expect(steered).toHaveLength(1)
  // A steer's string is the message's one text part, which is how a Prompt holds a user message made from a string.
  expect(
    steered[0]?.map((message) => [
      message.role,
      message.role === "user"
        ? message.content.map((part) =>
            part.type === "text" ? part.text : part.type,
          )
        : [],
    ]),
  ).toEqual([
    ["user", ["first"]],
    ["user", ["second"]],
  ])
})
