import { Effect } from "effect"
import { ChatHandler, ChatThread } from "effect/chat"
import type { Connection } from "./Connection.ts"
import * as Logger from "./Logger.ts"
import { Message, Session } from "./SessionEntity.ts"

/**
 * What chad does with an inbound event of one connection. A message of chad's own bot is dropped first, then a
 * message whose author is not on the connection's owner list, and an owner's message is saved as a request to the
 * session of its thread. The allowlist is by user id and nothing else.
 */
export const layer = (connection: Connection) =>
  ChatHandler.layer(
    Effect.fnUntraced(function* (event) {
      if (event._tag !== "MessageCreated") return
      const author = event.message.author
      const ignored = (reason: "own" | "not-owner") =>
        Logger.event("message.ignored", "A message was ignored", {
          reason,
          author: author.id,
          connection: connection.name,
        })
      if (author.isSelf) return yield* ignored("own")
      if (!connection.owners.includes(author.id)) {
        return yield* ignored("not-owner")
      }
      // A message in a channel belongs to no session until a later slice opens a thread for it.
      if (event.kind === "channel") return
      const session = yield* Session.client
      yield* session(ChatThread.toString(event.thread))
        .message(Message.fromEvent(event), { discard: true })
        .pipe(Effect.orDie)
    }),
    // effect/chat would drop chad's own messages without a word, and chad logs the drop.
    { deliverSelf: true },
  )
