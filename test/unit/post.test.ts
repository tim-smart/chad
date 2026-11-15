import { Duration, Effect, Layer } from "effect"
import { Chat, ChatError, ChatTest, ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import * as Format from "../../src/daemon/Format.ts"
import * as Post from "../../src/daemon/Post.ts"
import { discordDescriptor } from "../support/platform.ts"

/** A ChatTest platform with Discord's limits and no floor between writes, and its `Chat`. */
const platform = Effect.gen(function* () {
  const discord = yield* discordDescriptor
  return yield* Effect.gen(function* () {
    return { test: yield* ChatTest.ChatTest, chat: yield* Chat.Chat }
  }).pipe(
    Effect.provide(
      Layer.fresh(
        ChatTest.layer({
          platform: "local",
          capabilities: [...discord.capabilities],
          limits: { ...discord.limits, minWriteInterval: Duration.zero },
          measure: discord.measure,
        }),
      ),
    ),
  )
})

/** Numbered lines, so that a lost, repeated or reordered one shows. */
const numbered = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `${prefix} ${String(index).padStart(4, "0")} ${"x".repeat(60)}`,
  )

const counted = /^(?:text|code) \d{4} x+$/

test("DIS-51 DIS-54 an answer longer than five messages goes out in five and answer.md, with nothing lost or reordered and a cut code fence reopened, and a post that fails in the middle sends only the unsent remainder again", async () => {
  const blocks = [
    numbered("text", 20).join("\n"),
    ["```ts", ...numbered("code", 60), "```"].join("\n"),
    ...Array.from({ length: 8 }, () => numbered("text", 20).join("\n")),
  ]
  // Each block's lines are numbered from 0, so the blocks are told apart by their place in the whole.
  const answer = blocks.join("\n\n")
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { test, chat } = yield* platform
      const thread = yield* test.makeThread("direct")
      // The third post fails once, after two parts went out.
      let posts = 0
      const failing: typeof chat = {
        ...chat,
        post: (where, content) =>
          ++posts === 3
            ? Effect.fail(
                new ChatError.ChatError({
                  platform: where.platform,
                  op: "post",
                  reason: new ChatError.Forbidden({ detail: "Missing Access" }),
                }),
              )
            : chat.post(where, content),
      }
      const posting = yield* Post.post(failing, Format.local, thread, answer, {
        answer: {},
      })
      const calls = (yield* test.calls).filter(
        (call) => call.op === "post" && call.outcome === "ok",
      )
      return { posting, calls, thread }
    }),
  )
  expect(result.posting).toBe("posted")
  const texts = result.calls.filter((call) => call.files === undefined)
  const files = result.calls.filter((call) => call.files !== undefined)
  expect(texts).toHaveLength(Post.maxParts)
  expect(files.map((call) => call.files?.map((file) => file.name))).toEqual([
    [Post.overflowFile],
  ])
  const markdown = [
    ...texts.map((call) => call.markdown ?? ""),
    new TextDecoder().decode(files[0]!.files![0]!.content),
  ]
  // Every line of the answer is there once, in its order.
  const lines = (text: string) =>
    text.split("\n").filter((line) => counted.test(line))
  expect(markdown.flatMap(lines)).toEqual(lines(answer))
  // The code block is longer than a message: its part closes the fence and the next part opens it again.
  const cut = texts.findIndex((call) =>
    /^```ts\ncode (?!0000)/.test(call.markdown ?? ""),
  )
  expect(cut).toBeGreaterThan(0)
  expect(texts[cut - 1]!.markdown?.trimEnd().endsWith("```")).toBe(true)
  expect(ChatThread.toString(texts[0]!.thread)).toBe(
    ChatThread.toString(result.thread),
  )
})

test("DIS-100 FAIL-66 a post that replies to a message that is gone goes out as a plain post", async () => {
  const { posting, messages } = await Effect.runPromise(
    Effect.gen(function* () {
      const { test, chat } = yield* platform
      const thread = yield* test.makeThread("thread")
      const posting = yield* Post.post(
        chat,
        Format.local,
        thread,
        "the turn failed",
        {
          replyTo: "999",
        },
      )
      return { posting, messages: yield* test.messages(thread) }
    }),
  )
  expect(posting).toBe("posted")
  const mine = messages.filter((message) => message.author.isSelf)
  expect(mine.map((message) => [message.text, message.replyTo])).toEqual([
    ["the turn failed", undefined],
  ])
})
