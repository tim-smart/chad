import { Cause, Context, DateTime, Effect, Exit } from "effect"
import {
  Chat,
  ChatEvent,
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
import * as Disk from "./Disk.ts"
import * as Logger from "./Logger.ts"
import { Message, Session } from "./SessionEntity.ts"
import * as Notices from "./Notices.ts"
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
        // A command is not a persisted request, so its stored claim is what keeps a second delivery from running it
        // again: the other connection of a thread two bots share, a replay or a catch-up, before a restart or after
        // it (SES-203, SES-204).
        const claim = (where: ChatThread.ChatThread) =>
          Sessions.claim(ChatEvent.dedupeKey(event), ChatThread.toString(where))
        const mentioned = ChatMessage.mentionsSelf(message)
        const word = command(message)
        const status = Effect.flatMap(Status, (service) => service.text)

        let thread = event.thread
        if (event.kind === "channel") {
          if (!mentioned) return yield* ignored("not-mentioned")
          if (word !== undefined && !(yield* claim(thread))) {
            return yield* ignored("duplicate")
          }
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
        } else if (word !== undefined && !(yield* claim(thread))) {
          return yield* ignored("duplicate")
        }

        const key = ChatThread.toString(thread)
        // Every owner's message in a thread counts for where a notice outside a turn goes, a chat command included,
        // and it is worked out here so that no query finds it (FAIL-158, FAIL-231, REC-145).
        yield* (yield* Notices.Notices).arrived({
          connection: connection.name,
          thread: key,
          direct: event.kind === "direct",
        })
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

        // A save that fails because the data volume is full is answered in the thread, and the event is accepted once
        // the answer is posted, so it is not replayed and the message does not run later by itself. Any other failed
        // save, and a full one whose answer cannot be posted either, refuses the event so that the platform sends it
        // again (FAIL-136, FAIL-137, SES-127).
        const unsaved = (cause: Cause.Cause<unknown>) =>
          Disk.isFull(cause)
            ? Logger.event(
                "disk.full",
                "A write failed because the data volume is full",
                { connection: connection.name, thread: key },
                cause,
              ).pipe(
                Effect.andThen(ChatMarkdown.post(thread, Messages.diskFull)),
                Effect.catchCause(
                  refuse(
                    "The data volume is full, and the reply could not be posted",
                  ),
                ),
                Effect.as("full" as const),
              )
            : refuse("A message could not be saved")(cause)
        const saved = Effect.gen(function* () {
          // The session's row is there before the save, so the thread has a session from its first message on.
          if ((yield* Sessions.current(key)) === undefined) {
            yield* Sessions.open(key, yield* kind)
          }
          const request = Message.fromEvent(event, connection.name)
          const sharding = yield* Sharding.Sharding
          const storage = yield* MessageStorage.MessageStorage
          const id = EntityId.make(key)
          const held = yield* storage.requestIdForPrimaryKey({
            address: EntityAddress.make({
              shardId: sharding.getShardId(id, "default"),
              entityType: Session.type,
              entityId: id,
            }),
            tag: "message",
            id: request.key,
          })
          // Cluster drops a request it still holds by its key, and the log says that this event came a second time.
          if (held._tag === "Some") return "duplicate" as const
          yield* session.message(request, { discard: true })
          return "saved" as const
        })
        const outcome = yield* saved.pipe(Effect.catchCause(unsaved))
        if (outcome === "duplicate") return yield* ignored("duplicate")
        if (outcome === "saved") yield* Sessions.mark(key, mark)
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

/**
 * The handler while the database cannot be opened or migrated (STO-118, FAIL-148, SES-29). Every owner's message gets
 * the error where it was posted, with or without a mention, and a plain channel opens no thread for it. `/status`
 * gets the status, which renders with no database. Nothing is saved, so a post that fails is logged and the event is
 * not refused.
 */
export const unusable = (
  connection: Live,
  text: string,
  status: Effect.Effect<string>,
) =>
  ChatHandler.layer(
    Effect.fnUntraced(function* (event) {
      if (event._tag !== "MessageCreated") return
      const { message } = event
      const ignored = (reason: "own" | "not-owner") =>
        Logger.event("message.ignored", "A message was ignored", {
          reason,
          author: message.author.id,
          connection: connection.name,
        })
      if (message.author.isSelf) return yield* ignored("own")
      if (!connection.owners().includes(message.author.id)) {
        return yield* ignored("not-owner")
      }
      const answer =
        command(message) === "status" ? Messages.status(yield* status) : text
      yield* ChatMarkdown.post(event.thread, answer).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("A message could not be posted", cause),
        ),
      )
    }),
    { deliverSelf: true },
  )
