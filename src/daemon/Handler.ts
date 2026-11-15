import { Context, DateTime, Effect, Exit } from "effect"
import {
  Chat,
  ChatHandler,
  ChatMarkdown,
  ChatMessage,
  ChatThread,
} from "effect/chat"
import {
  EntityAddress,
  EntityId,
  MessageStorage,
  Sharding,
} from "effect/cluster"
import * as Messages from "../Messages.ts"
import type { Live } from "./Chats.ts"
import * as Logger from "./Logger.ts"
import { Message, Session } from "./SessionEntity.ts"
import * as Sessions from "./Sessions.ts"

/** What `/status` prints, which is the text `chad status` prints for the same daemon call. */
export class Status extends Context.Service<
  Status,
  { readonly text: Effect.Effect<string> }
>()("chad/Handler/Status") {}

/** The chat commands, by their first word. They are plain text, and none of them reaches the model. */
const commands = {
  "/new": "new",
  "/stop": "stop",
  "/status": "status",
} as const

/**
 * The chat command a message is, when it is one. The mention of chad is stripped first, and the command is the first
 * word of what is left, whatever its case. The text after it is ignored.
 */
export const command = (
  message: Pick<ChatMessage.ChatMessage, "text" | "mentions">,
): (typeof commands)[keyof typeof commands] | undefined => {
  let text = ""
  let from = 0
  const own = message.mentions
    .filter((mention) => mention.isSelf)
    .toSorted((a, b) => a.start - b.start)
  for (const mention of own) {
    text += message.text.slice(from, mention.start)
    from = mention.end
  }
  text += message.text.slice(from)
  const word = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  return Object.hasOwn(commands, word)
    ? commands[word as keyof typeof commands]
    : undefined
}

/**
 * What chad does with an inbound event of one connection. A message of chad's own bot is dropped first, then a
 * message whose author is not on the connection's owner list. The allowlist is by user id and nothing else, and it is
 * read at each message, so an owner change holds from the next one on.
 *
 * An owner's message needs no mention in a direct message or in a thread that has a session. In a plain channel it
 * needs one, and chad opens a thread on it, which is the session. A chat command goes to the session as a request
 * that is not persisted, and every other message is saved as a request to the session of its thread. The handler
 * never waits for a turn.
 */
export const layer = (connection: Live) =>
  ChatHandler.layer(
    Effect.fnUntraced(
      function* (event) {
        if (event._tag !== "MessageCreated") return
        const { message } = event
        const author = message.author
        const ignored = (
          reason: "own" | "not-owner" | "not-mentioned" | "duplicate",
        ) =>
          Logger.event("message.ignored", "A message was ignored", {
            reason,
            author: author.id,
            connection: connection.name,
          })
        if (author.isSelf) return yield* ignored("own")
        if (!connection.owners().includes(author.id)) {
          return yield* ignored("not-owner")
        }

        const chat = yield* Chat.Chat
        const say = (thread: ChatThread.ChatThread, markdown: string) =>
          ChatMarkdown.post(thread, markdown).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("A message could not be posted", cause),
            ),
            Effect.asVoid,
          )
        const refuse = (what: string) => (cause: unknown) =>
          Effect.logError(what, cause).pipe(
            Effect.andThen(Effect.fail(new ChatHandler.NotAccepted())),
          )
        const mentioned = ChatMessage.mentionsSelf(message)
        const word = command(message)
        const status = Effect.flatMap(Status, (service) => service.text)

        let thread = event.thread
        if (event.kind === "channel") {
          if (!mentioned) return yield* ignored("not-mentioned")
          // A command in a plain channel is answered there and opens no thread, which would be a session that nothing
          // has been said in.
          if (word === "status") {
            return yield* say(thread, Messages.status(yield* status))
          }
          if (word !== undefined)
            return yield* say(thread, Messages.noSession())
          // The thread is opened before the save, so an event that is delivered again lands on the same thread.
          const opened = yield* Effect.exit(
            chat.startThread(thread, message.id),
          )
          if (Exit.isFailure(opened)) {
            const error = opened.cause.reasons.find(
              (reason) => reason._tag === "Fail",
            )?.error
            yield* Effect.logWarning(
              "A thread could not be opened",
              opened.cause,
            )
            return yield* say(
              thread,
              Messages.threadFailed(
                error?.reason.detail ?? error?.reason._tag ?? "unknown",
              ),
            )
          }
          thread = opened.value
        } else if (
          event.kind === "thread" &&
          !mentioned &&
          !(yield* Sessions.known(ChatThread.toString(thread)))
        ) {
          return yield* ignored("not-mentioned")
        }

        const key = ChatThread.toString(thread)
        // The kind of a session is read from effect/chat for its thread, because the event of a mention in a plain
        // channel has the kind of the channel. A session that an owner's message opens in a server is a thread.
        const kind = chat.getThread(thread).pipe(
          Effect.map((info) => info.kind),
          Effect.catch(() => Effect.succeed(event.kind)),
          Effect.map((kind) => (kind === "direct" ? "direct" : "thread")),
        )
        const mark = {
          id: message.id,
          at: DateTime.toEpochMillis(message.timestamp),
        }
        const session = (yield* Session.client)(key)
        const sender = { by: author.id, connection: connection.name }
        if (word === "status") {
          yield* say(thread, Messages.status(yield* status))
          return yield* Sessions.mark(key, mark)
        }
        if (word === "stop") {
          yield* session
            .stop(sender)
            .pipe(Effect.catchCause(refuse("A stop could not be delivered")))
          return yield* Sessions.mark(key, mark)
        }
        if (word === "new") {
          // The entity has accepted the reset when this returns, so the next message belongs to the new session.
          return yield* session
            .reset({
              ...sender,
              kind: yield* kind,
              message: mark.id,
              at: mark.at,
            })
            .pipe(Effect.catchCause(refuse("A reset could not be delivered")))
        }

        // The session's row is there before the save, so the thread has a session from its first message on.
        if ((yield* Sessions.current(key)) === undefined) {
          yield* Sessions.open(key, yield* kind)
        }
        const request = Message.fromEvent(event, connection.name)
        const sharding = yield* Sharding.Sharding
        const storage = yield* MessageStorage.MessageStorage
        const id = EntityId.make(key)
        const held = yield* storage
          .requestIdForPrimaryKey({
            address: EntityAddress.make({
              shardId: sharding.getShardId(id, "default"),
              entityType: Session.type,
              entityId: id,
            }),
            tag: "message",
            id: request.key,
          })
          .pipe(Effect.catchCause(refuse("A message could not be saved")))
        // Cluster drops a request it still holds by its key, and the log says that this event came a second time.
        if (held._tag === "Some") return yield* ignored("duplicate")
        // The event is refused only when the save fails, so that the platform sends it again.
        yield* session
          .message(request, { discard: true })
          .pipe(Effect.catchCause(refuse("A message could not be saved")))
        yield* Sessions.mark(key, mark)
      },
      Effect.catchTag("SqlError", (error) =>
        Effect.logError("A message could not be handled", error).pipe(
          Effect.andThen(Effect.fail(new ChatHandler.NotAccepted())),
        ),
      ),
    ),
    // effect/chat would drop chad's own messages without a word, and chad logs the drop.
    { deliverSelf: true },
  )
