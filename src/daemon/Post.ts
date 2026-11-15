import { Cause, Effect, Exit } from "effect"
import {
  Chat,
  type ChatAdapter,
  ChatError,
  ChatMarkdown,
  type ChatThread,
} from "effect/chat"
import type { ChatService } from "./Chats.ts"
import type { Format } from "./Format.ts"
import * as Logger from "./Logger.ts"

/**
 * How chad posts in a session's thread (docs/spec/04-discord.md, "The answer"): the split of long Markdown, the reply to
 * the owner's message and the second try of an answer.
 */

/** The most messages a post goes out in. Whatever is left after them is one file (DIS-51). */
export const maxParts = 5

/** The name of the file that carries the rest of a post past its last message (DIS-51). */
export const overflowFile = "answer.md"

/** What became of a post: it reached the thread, the thread is gone, or it failed otherwise. */
export type Posting = "posted" | "gone" | "failed"

export interface Options {
  /**
   * The owner's message the post replies to, under the formatter's reply options: the reply ping on, and a plain post
   * when that message is gone (DIS-55, DIS-100, FAIL-66).
   */
  readonly replyTo?: string | undefined
  /**
   * Set for an answer, with the ids its log line carries. A failed answer has its unsent remainder tried once more,
   * and a second failure is logged as `turn.answer-unposted` (DIS-54, FAIL-256).
   */
  readonly answer?: Readonly<Record<string, unknown>> | undefined
}

/** The error of a failed post, unwrapped from `ChatMarkdown`'s. */
const failure = (cause: Cause.Cause<unknown>) =>
  cause.reasons.find((reason) => reason._tag === "Fail")?.error

/** Whether a post failed because the platform does not have the thread or the message (FAIL-44). */
const notFound = (cause: Cause.Cause<unknown>) => {
  const error = failure(cause)
  const chat =
    error instanceof ChatMarkdown.ChatMarkdownError &&
    error.cause._tag === "Chat"
      ? error.cause.error
      : error
  return ChatError.isChatError(chat) && chat.reason._tag === "NotFound"
}

const markdown = (
  chat: ChatService,
  format: Format,
  thread: ChatThread.ChatThread,
  text: string,
  parts: number,
  replyTo: string | undefined,
) =>
  ChatMarkdown.post(thread, text, {
    maxParts: parts,
    overflow: { file: { name: overflowFile } },
    ...(replyTo === undefined ? {} : { replyTo: { messageId: replyTo } }),
  }).pipe(Effect.provideService(Chat.Chat, chat), (effect) =>
    replyTo === undefined ? effect : format.reply(effect),
  )

/**
 * Posts Markdown in the thread, in up to `maxParts` messages and then the file (DIS-51), and says what became of it.
 * A failed post that left its reply unsent, and a failed answer, try what was not sent once more. That try is a plain
 * post, except after a failure that was worth a retry, so that a reply the platform refused does not make the post
 * fail (DIS-100, DIS-119). Its first part is a reply only when nothing was posted before it.
 */
export const post = Effect.fnUntraced(function* (
  chat: ChatService,
  format: Format,
  thread: ChatThread.ChatThread,
  text: string,
  options: Options = {},
): Effect.fn.Return<Posting> {
  const first = yield* Effect.exit(
    markdown(chat, format, thread, text, maxParts, options.replyTo),
  )
  if (Exit.isSuccess(first)) return "posted"
  const error = failure(first.cause)
  const sent =
    error instanceof ChatMarkdown.ChatMarkdownError
      ? error.posted.filter((part) => part.kind === "text").length
      : 0
  if (
    !(error instanceof ChatMarkdown.ChatMarkdownError) ||
    (options.answer === undefined &&
      (options.replyTo === undefined || sent > 0))
  ) {
    yield* Effect.logError("A message could not be posted", first.cause)
    return notFound(first.cause) ? "gone" : "failed"
  }
  // What was sent and never confirmed is not sent again, since it may have landed.
  const rest =
    (error.remainingFence ?? "") === ""
      ? error.remaining
      : `${error.remainingFence}\n${error.remaining}`
  if (error.remaining.trim() === "") {
    yield* Effect.logWarning("A message may not have been posted", first.cause)
    return "posted"
  }
  yield* Effect.logWarning(
    "A message could not be posted, trying again",
    first.cause,
  )
  const again =
    sent === 0 &&
    error.cause._tag === "Chat" &&
    error.cause.error.reason.retry === "retry"
      ? options.replyTo
      : undefined
  // A part that may have landed is not sent again, and it still takes one of the messages (DIS-51). A post sends each
  // part once, so what is uncertain is the one part whose write failed.
  const slots = maxParts - sent - ((error.uncertain ?? "") === "" ? 0 : 1)
  // `ChatMarkdown` posts at least one part, so with no slot left the rest goes out as the file alone.
  const retry: Effect.Effect<void, unknown> =
    slots > 0
      ? markdown(chat, format, thread, rest, slots, again)
      : chat.post(thread, { markdown: "", files: [file(rest)] })
  const second = yield* Effect.exit(retry)
  if (Exit.isSuccess(second)) return "posted"
  if (notFound(second.cause)) {
    yield* Effect.logError("A message could not be posted", second.cause)
    return "gone"
  }
  if (options.answer === undefined) {
    yield* Effect.logError("A message could not be posted", second.cause)
  } else {
    yield* Logger.event(
      "turn.answer-unposted",
      "The answer could not be posted",
      options.answer,
      second.cause,
    )
  }
  return "failed"
})

/** The rest of a post past its last message, as the one file that carries it. */
const file = (text: string): ChatAdapter.File => ({
  name: overflowFile,
  contentType: "text/markdown",
  content: new TextEncoder().encode(text),
})
