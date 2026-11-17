import { Duration, Effect, Stream } from "effect"
import { ChatAdapter, ChatHandler, ChatThread } from "effect/chat"
import { Timings } from "../Timings.ts"
import * as Sessions from "./Sessions.ts"

/**
 * The catch-up after a gateway that had to identify again instead of resuming. For each session of the platform that
 * is still active, it reads forward from the last message chad saw in it and hands each owner message it finds to the
 * gateway handler, which saves it as any message is saved. A message the handler already saved is dropped there by its
 * key.
 */
export const run = Effect.fnUntraced(function* (platform: string) {
  const timings = yield* Timings
  const registry = yield* ChatAdapter.Registry
  const handler = yield* ChatHandler.ChatHandler
  const adapter = yield* registry.get(platform)
  const since = Date.now() - Duration.toMillis(timings.catchUpWindow)
  for (const session of yield* Sessions.active(since)) {
    const found = ChatThread.fromString(session.thread)
    if (found._tag === "None" || found.value.platform !== platform) continue
    const thread = found.value
    const kind = session.kind === "direct" ? "direct" : "thread"
    yield* adapter
      .history(thread, { direction: "forward", from: session.last_message_id })
      .pipe(
        Stream.filter((message) => !message.author.isSelf),
        Stream.runForEach((message) =>
          handler.handle({
            _tag: "MessageCreated",
            thread,
            kind,
            message,
            raw: message.raw,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("A session could not be caught up", cause),
        ),
      )
  }
})
