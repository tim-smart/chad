import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Option,
  Stream,
} from "effect"
import {
  Chat,
  ChatEvent,
  ChatHandler,
  ChatInteraction,
  ChatMarkdown,
  ChatMessage,
  ChatThread,
  ChatUi,
} from "effect/chat"
import {
  EntityAddress,
  EntityId,
  MessageStorage,
  Sharding,
} from "effect/cluster"
import * as Messages from "../Messages.ts"
import {
  McpLoginButton,
  McpLoginForm,
  McpLoginPaste,
} from "../plugins/request-mcp-login/Form.ts"
import { SecretButton, SecretForm } from "../plugins/request-secret/Form.ts"
import type { Live } from "./Chats.ts"
import * as Disk from "./Disk.ts"
import * as Logger from "./Logger.ts"
import * as Model from "./Model.ts"
import { Message, Session } from "./SessionEntity.ts"
import * as Notices from "./Notices.ts"
import { Timings } from "../Timings.ts"
import * as Sessions from "./Sessions.ts"
import * as SlashCommands from "./SlashCommands.ts"
import { StopButton } from "./StatusMessage.ts"

/** What `/status` prints, which is the text `chad status` prints for the same daemon call. */
export class Status extends Context.Service<
  Status,
  { readonly text: Effect.Effect<string> }
>()("chad/Handler/Status") {}

/**
 * `/model`, which runs outside the handler of its event: the handler hands it the words after the command and where it
 * was typed, and is done.
 */
export class ModelCommand extends Context.Service<
  ModelCommand,
  {
    readonly run: (
      words: ReadonlyArray<string>,
      where: {
        /** A link to where the command was typed, as its platform writes one. */
        readonly link: string
        /** Posts a message where the command was typed. */
        readonly post: (markdown: string) => Effect.Effect<void>
      },
    ) => Effect.Effect<void>
  }
>()("chad/Handler/ModelCommand") {}

/**
 * `/safe [on|off]`, which runs `chad safe` in the daemon and posts what it prints where it was typed.
 */
export const SafeCommand = Context.Reference<{
  readonly run: (
    to: "on" | "off" | undefined,
    post: (markdown: string) => Effect.Effect<void>,
  ) => Effect.Effect<void>
}>("chad/Handler/SafeCommand", {
  defaultValue: () => ({ run: () => Effect.void }),
})

/**
 * Saves a secret that an owner submitted in a request's form, as `chad secret set` does through the daemon's queue,
 * and reports what that command prints, marking only a successful final result as saved.
 * Nothing it posts or logs carries the value.
 */
export const SecretSave = Context.Reference<{
  readonly run: (
    secret: {
      readonly name: string
      readonly value: string
      readonly note: string | undefined
    },
    post: (markdown: string, saved?: boolean) => Effect.Effect<void>,
  ) => Effect.Effect<void>
}>("chad/Handler/SecretSave", {
  defaultValue: () => ({ run: () => Effect.void }),
})

/**
 * An owner's OAuth sign-in to an MCP server from chat. `begin` gives the link, or why there is none. `finish` takes
 * the address the owner's browser ended on, as `chad mcp login` does through the daemon's queue, and posts what that
 * command prints. Nothing it posts or logs carries the address or a token.
 */
export const McpLogin = Context.Reference<{
  readonly begin: (server: string) => Effect.Effect<string, string>
  readonly finish: (
    sign: { readonly server: string; readonly address: string },
    post: (markdown: string) => Effect.Effect<void>,
  ) => Effect.Effect<void>
}>("chad/Handler/McpLogin", {
  defaultValue: () => ({
    begin: () => Effect.fail(""),
    finish: () => Effect.void,
  }),
})

/** The longest URL Discord takes on a link button. A longer link goes in the message. */
const linkButtonLength = 512

/**
 * Whether a message counts as mentioning chad: it mentions chad, or it was posted in a channel or thread whose id is
 * on the connection's list of channels that need no mention. A direct message needs none anyway.
 */
const addressed = (
  connection: Live,
  event: Pick<ChatEvent.MessageCreated, "kind" | "thread" | "message">,
) =>
  ChatMessage.mentionsSelf(event.message) ||
  (event.kind !== "direct" && connection.channels().includes(event.thread.id))

/**
 * The title tasks of one connection's threads. The set is built with the connection's handler, in the connection's
 * scope, so a task outlives the event that started it and ends when the connection is removed or swapped, or the daemon
 * stops.
 */
class TitleTasks extends Context.Service<TitleTasks, FiberSet.FiberSet<void>>()(
  "chad/Handler/TitleTasks",
) {}

/**
 * Titles a new thread from the message that opened it, as one job with one deadline: the model's token, its layer, its
 * answer and the rename. The rename is read when it runs, so a connection that is being taken down renames nothing.
 * Until the rename, and for good when the job fails, the thread keeps the name the platform gave it.
 */
const titled = (
  connection: Live,
  thread: ChatThread.ChatThread,
  text: string,
) =>
  Effect.gen(function* () {
    const fields = {
      connection: connection.name,
      thread: ChatThread.toString(thread),
    }
    const timings = yield* Timings
    const job = Effect.gen(function* () {
      const title = yield* (yield* Model.Models).title(text)
      const rename = connection.rename()
      if (rename === undefined) {
        return yield* Effect.fail(new Error(Messages.titleNoRename))
      }
      yield* rename(thread, title)
      return title
    }).pipe(
      Effect.timeoutOrElse({
        duration: timings.threadTitle,
        orElse: () => Effect.fail(new Error(Messages.modelTrialTimedOut)),
      }),
    )
    yield* job.pipe(
      Effect.flatMap((title) =>
        Logger.event("thread.titled", "A thread was titled", {
          ...fields,
          title,
        }),
      ),
      Effect.catchCause((cause) =>
        Logger.event(
          "thread.untitled",
          "A thread could not be titled",
          fields,
          cause,
        ),
      ),
      FiberSet.run(yield* TitleTasks),
    )
  })

/** The chat commands, by their first word. They are plain text, and none of them reaches the model. */
const commands = {
  "/new": "new",
  "/stop": "stop",
  "/status": "status",
  "/model": "model",
  "/safe": "safe",
} as const

/** The text of a message with the mention of chad stripped, trimmed. */
const stripped = (
  message: Pick<ChatMessage.ChatMessage, "text" | "mentions">,
) => {
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
  return text.trim()
}

/** The words of a message, with the mention of chad stripped first. */
const words = (message: Pick<ChatMessage.ChatMessage, "text" | "mentions">) =>
  stripped(message).split(/\s+/)

/**
 * The chat command a message is, when it is one. The mention of chad is stripped first, and the command is the first
 * word of what is left, whatever its case. Only `/model` reads the words after it.
 */
export const command = (
  message: Pick<ChatMessage.ChatMessage, "text" | "mentions">,
): (typeof commands)[keyof typeof commands] | undefined => {
  const word = words(message)[0]?.toLowerCase() ?? ""
  return Object.hasOwn(commands, word)
    ? commands[word as keyof typeof commands]
    : undefined
}

/**
 * What chad does with an inbound event of one connection. A message of chad's own bot is dropped first, then a
 * message whose author is not on the connection's owner list. The allowlist is by user id and nothing else, and it is
 * read at each message, so an owner change holds from the next one on.
 *
 * An owner's message needs no mention in a direct message, in a thread that has a session, or in a channel or thread
 * whose id is on the connection's channel list. Anywhere else it needs one. In a plain channel chad opens a thread on
 * it, which is the session. A chat command goes to the session as a request that is not persisted, and every other
 * message is saved as a request to the session of its thread. The handler never waits for a turn.
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
        // it.
        const claim = (where: ChatThread.ChatThread) =>
          Sessions.claim(ChatEvent.dedupeKey(event), ChatThread.toString(where))
        const mentioned = addressed(connection, event)
        const word = command(message)
        const status = Effect.flatMap(Status, (service) => service.text)
        // `/model` is answered where it was typed, in a plain channel too, which gets no thread for it.
        const model = (where: ChatThread.ChatThread) =>
          Effect.flatMap(ModelCommand, (service) =>
            service.run(words(message).slice(1), {
              link: connection.format.link(where),
              post: (markdown) =>
                say(where, markdown).pipe(
                  Effect.provideService(Chat.Chat, chat),
                ),
            }),
          )

        // `/safe` is answered where it was typed, as `/model` is, and its words after the first are `on` or `off`.
        const safe = (where: ChatThread.ChatThread) =>
          Effect.flatMap(SafeCommand, (service) => {
            const to = words(message)[1]?.toLowerCase()
            return service.run(
              to === "on" || to === "off" ? to : undefined,
              (markdown) =>
                say(where, markdown).pipe(
                  Effect.provideService(Chat.Chat, chat),
                ),
            )
          })

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
          if (word === "model") return yield* model(thread)
          if (word === "safe") return yield* safe(thread)
          if (word !== undefined)
            return yield* say(thread, Messages.noSession(connection.format))
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
          // A thread with no session yet is new, and the model titles it on a fiber of the connection's, so the
          // message is saved without waiting. A platform that cannot rename a thread gets no title request.
          const text = stripped(message)
          if (
            connection.rename() !== undefined &&
            text !== "" &&
            (yield* Sessions.current(ChatThread.toString(thread))) === undefined
          ) {
            yield* titled(connection, thread, text)
          }
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
        // and it is worked out here so that no query finds it.
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
        if (word === "model") {
          yield* model(thread)
          return yield* Sessions.mark(key, mark)
        }
        if (word === "safe") {
          yield* safe(thread)
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
        // again.
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
  ).pipe(Layer.provide(Layer.effect(TitleTasks, FiberSet.make<void>())))

/**
 * The handler while the database cannot be opened or migrated. An owner's message in a direct message, or one that
 * mentions chad or is in a channel that needs no mention, gets the error where it was posted, and a plain channel opens
 * no thread for it. `/status` gets the status, which renders with no database. Any other message in a thread or a plain
 * channel is ignored, because which threads are sessions is in the database. Nothing is saved, so a post that fails is logged and
 * the event is not refused.
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
      const ignored = (reason: "own" | "not-owner" | "not-mentioned") =>
        Logger.event("message.ignored", "A message was ignored", {
          reason,
          author: message.author.id,
          connection: connection.name,
        })
      if (message.author.isSelf) return yield* ignored("own")
      if (!connection.owners().includes(message.author.id)) {
        return yield* ignored("not-owner")
      }
      if (event.kind !== "direct" && !addressed(connection, event)) {
        return yield* ignored("not-mentioned")
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

/**
 * What chad does with the clicks, form submits and slash commands of one connection. Each is answered at once, inside
 * the platform's deadline, and what it starts runs after the answer. One from anyone who is not an owner is answered
 * and does nothing else.
 *
 * - A click on Stop goes to the session of its thread as the `stop` request that `/stop` sends.
 * - A click on a secret request's button opens its form, and the form's submit saves the secret as `chad secret set`
 *   does. The value goes from the submit to the store: no message, log line or session gets it.
 * - A click on an MCP sign-in request's button begins the sign-in and posts its link with a second button, which
 *   opens the form for the address the browser ended on. The form's submit finishes the sign-in as `chad mcp login`
 *   does. The address goes from the submit to the daemon: no message, log line or session gets it.
 * - A slash command does what the typed command of its name does, and gets a private answer that only says it runs.
 *   `/new` and `/stop` need the thread to have a session, and `/new` starts the new one at the thread's newest
 *   message.
 */
export const interactions = (connection: Live) =>
  ChatInteraction.group(
    StopButton,
    SecretButton,
    SecretForm,
    McpLoginButton,
    McpLoginPaste,
    McpLoginForm,
  )
    .merge(SlashCommands.all)
    .toLayer(
      Effect.gen(function* () {
        const chat = yield* Chat.Chat
        const owner = (id: string) => connection.owners().includes(id)
        const sender = (by: string) => ({ by, connection: connection.name })
        const post = (thread: ChatThread.ChatThread) => (markdown: string) =>
          ChatMarkdown.post(thread, markdown).pipe(
            Effect.provideService(Chat.Chat, chat),
            Effect.catchCause((cause) =>
              Effect.logError("A message could not be posted", cause),
            ),
            Effect.asVoid,
          )
        /** Runs what a slash command does after its answer, and gives the answer. */
        const taken = <R>(
          command: ChatInteraction.CommandInvoked,
          work: Effect.Effect<void, unknown, R>,
        ) =>
          work.pipe(
            Effect.catchCause((cause) =>
              Effect.logError("A slash command failed", cause),
            ),
            Effect.forkDetach,
            Effect.as(
              ChatInteraction.respond({
                markdown: Messages.commandTaken(command.id),
                visibility: "ephemeral",
              }),
            ),
          )
        const refused = (markdown: string) =>
          Effect.succeed(
            ChatInteraction.respond({ markdown, visibility: "ephemeral" }),
          )
        /** A slash command that needs the thread's session: `/new` and `/stop`. */
        const inSession = <R>(
          command: ChatInteraction.CommandInvoked,
          work: (
            key: string,
            session: Sessions.Session,
          ) => Effect.Effect<void, unknown, R>,
        ) =>
          Effect.gen(function* () {
            if (!owner(command.userId)) {
              return yield* refused(Messages.commandNotOwner)
            }
            const key = ChatThread.toString(command.thread)
            const session = yield* Sessions.current(key).pipe(
              Effect.orElseSucceed(() => undefined),
            )
            if (session === undefined) {
              return yield* refused(Messages.noSession(connection.format))
            }
            return yield* taken(command, work(key, session))
          })
        const anywhere = <R>(
          command: ChatInteraction.CommandInvoked,
          work: Effect.Effect<void, unknown, R>,
        ) =>
          owner(command.userId)
            ? taken(command, work)
            : refused(Messages.commandNotOwner)
        const client = yield* Session.client
        return {
          "stop-turn": (click) =>
            Effect.gen(function* () {
              if (!owner(click.userId)) return ChatInteraction.ack
              yield* client(ChatThread.toString(click.thread))
                .stop(sender(click.userId))
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("A stop could not be delivered", cause),
                  ),
                  Effect.forkDetach,
                )
              return ChatInteraction.ack
            }),
          secret: (click) =>
            Effect.succeed(
              owner(click.userId)
                ? SecretForm.open({ metadata: click.value })
                : ChatInteraction.ack,
            ),
          "secret-form": (submit) =>
            Effect.gen(function* () {
              if (!owner(submit.userId)) return ChatInteraction.close
              const say = post(submit.thread)
              yield* Effect.flatMap(SecretSave, (service) =>
                service.run(
                  {
                    name: submit.metadata,
                    value: submit.values.value,
                    note: submit.values.note,
                  },
                  (markdown, saved) => {
                    const text = markdown
                      .split("\n")
                      .map(connection.format.subtext)
                      .join("\n")
                    if (!saved || submit.messageId === undefined)
                      return say(text)
                    return chat
                      .edit(submit.thread, submit.messageId, {
                        markdown: text,
                        actions: [],
                      })
                      .pipe(
                        Effect.catchCause(() => say(text)),
                        Effect.asVoid,
                      )
                  },
                ),
              ).pipe(
                // The value is in the submit, which the cause does not carry.
                Effect.catchCause((cause) =>
                  Effect.logError("A secret could not be saved", cause),
                ),
                Effect.forkDetach,
              )
              return ChatInteraction.close
            }),
          "mcp-login": (click) =>
            Effect.gen(function* () {
              if (!owner(click.userId)) return ChatInteraction.ack
              const server = click.value
              const say = post(click.thread)
              // The link takes requests to the server, which do not fit in the click's deadline.
              yield* Effect.flatMap(McpLogin, (service) =>
                service.begin(server),
              ).pipe(
                Effect.matchEffect({
                  onFailure: say,
                  onSuccess: (url) =>
                    Effect.gen(function* () {
                      const button = url.length <= linkButtonLength
                      const message = {
                        markdown: [
                          Messages.mcpLoginSteps(server),
                          ...(button ? [] : [Messages.mcpLoginLink(url)]),
                        ].join("\n"),
                        actions: [
                          ...(button
                            ? [
                                ChatUi.linkButton({
                                  label: Messages.mcpLoginOpenLabel,
                                  url,
                                }),
                              ]
                            : []),
                          McpLoginPaste.of(server, {
                            label: Messages.mcpLoginPasteLabel,
                          }),
                        ],
                      }
                      // A link cannot be cut in two, so one that fits in no message is not posted, and the owner is
                      // told the way in that has no limit. The same goes for a message the platform did not take.
                      const { limits, measure } = yield* chat.descriptor(
                        click.thread.platform,
                      )
                      const long =
                        measure(message.markdown, message.actions) >
                        limits.messageLength
                      if (long)
                        return yield* say(
                          Messages.mcpLoginUnposted(server, true),
                        )
                      yield* chat
                        .post(click.thread, message)
                        .pipe(
                          Effect.catchCause((cause) =>
                            Effect.andThen(
                              Effect.logError(
                                "An MCP sign-in's link could not be posted",
                                cause,
                              ),
                              say(Messages.mcpLoginUnposted(server, false)),
                            ),
                          ),
                        )
                    }),
                }),
                Effect.catchCause((cause) =>
                  Effect.logError("An MCP sign-in could not begin", cause),
                ),
                Effect.forkDetach,
              )
              return ChatInteraction.ack
            }),
          "mcp-login-paste": (click) =>
            Effect.succeed(
              owner(click.userId)
                ? McpLoginForm.open({ metadata: click.value })
                : ChatInteraction.ack,
            ),
          "mcp-login-form": (submit) =>
            Effect.gen(function* () {
              if (!owner(submit.userId)) return ChatInteraction.close
              const say = post(submit.thread)
              yield* Effect.flatMap(McpLogin, (service) =>
                service.finish(
                  {
                    server: submit.metadata,
                    address: submit.values.address,
                  },
                  (markdown) =>
                    say(
                      markdown
                        .split("\n")
                        .map(connection.format.subtext)
                        .join("\n"),
                    ),
                ),
              ).pipe(
                // The address is in the submit, which the cause does not carry.
                Effect.catchCause((cause) =>
                  Effect.logError("An MCP sign-in could not finish", cause),
                ),
                Effect.forkDetach,
              )
              return ChatInteraction.close
            }),
          stop: (command) =>
            inSession(command, (key) =>
              client(key).stop(sender(command.userId)),
            ),
          new: (command) =>
            inSession(command, (key, session) =>
              Effect.gen(function* () {
                // The newest message is the new session's mark, as the `/new` message is for the typed command.
                const newest = yield* chat
                  .history(command.thread, { direction: "backward" })
                  .pipe(
                    Stream.take(1),
                    Stream.runHead,
                    Effect.orElseSucceed(() => Option.none()),
                  )
                yield* client(key).reset({
                  ...sender(command.userId),
                  kind: session.kind === "direct" ? "direct" : "thread",
                  message: Option.match(newest, {
                    onNone: () => "0",
                    onSome: (message) => message.id,
                  }),
                  at: Option.match(newest, {
                    onNone: () => 0,
                    onSome: (message) =>
                      DateTime.toEpochMillis(message.timestamp),
                  }),
                })
              }),
            ),
          status: (command) =>
            anywhere(
              command,
              Effect.flatMap(Status, (service) => service.text).pipe(
                Effect.flatMap((text) =>
                  post(command.thread)(Messages.status(text)),
                ),
              ),
            ),
          model: (command) =>
            anywhere(
              command,
              Effect.flatMap(ModelCommand, (service) =>
                service.run(command.text.trim().split(/\s+/).filter(Boolean), {
                  link: connection.format.link(command.thread),
                  post: post(command.thread),
                }),
              ),
            ),
          safe: (command) =>
            anywhere(
              command,
              Effect.flatMap(SafeCommand, (service) => {
                const to = command.text.trim().toLowerCase()
                return service.run(
                  to === "on" || to === "off" ? to : undefined,
                  post(command.thread),
                )
              }),
            ),
        }
      }),
    )
    .pipe(Layer.provideMerge(ChatInteraction.layer()))
