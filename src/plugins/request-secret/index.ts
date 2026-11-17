// The bundled plugin `request-secret`. Each of its tools posts a button in the session's thread, and a click opens a
// form for a value, so the value never passes through the tool, the script that called it or the model.
// `requestSecret` returns at once, and chad saves what the form submits in the secret store. `requestOnce` waits in
// the turn for the form, and the daemon keeps the value in memory for that turn only (`src/daemon/Once.ts`).
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Chat, ChatThread } from "effect/chat"
import * as Plugin from "../../Plugin.ts"
import { CurrentSession } from "../../Session.ts"
import { Name, OnceButton, SecretButton } from "./Form.ts"
import { Once } from "./Once.ts"

/** The name kept for writing a literal `${` in configuration, which the store refuses. */
const reserved = "CHAD_DOLLAR"

const tools = Toolkit.make(
  Tool.make("requestSecret", {
    description:
      "Ask the owner for a secret that is not stored, such as a password or an API key. It posts a button in this session's thread, and the owner enters the value in a form. The value goes into chad's secret store under name, and never into the chat or your context. reason says what the secret is for, and the owner reads it. It returns once the button is posted, before anything is saved: end your turn, and use the secret by its name once the owner says it is saved.",
    parameters: Schema.Struct({
      name: Schema.String,
      reason: Schema.String,
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
  Tool.make("requestOnce", {
    description:
      "Ask the owner for a value you need once and chad must not store, such as a code a site sent by SMS or email in the middle of a login. Call it when the site asks for the code, not before. It posts a button in this session's thread and waits, for a few minutes at most, for the owner to enter the value in a form. reason says which site the code is for and where it was sent, and the owner reads it. It returns once the value is ready under name, and never returns the value: run the command that needs it through chad secret run --env VAR=name or --stdin name, in this turn, and never print it. The value is gone when this turn ends. For a secret chad will need again, use requestSecret.",
    parameters: Schema.Struct({
      name: Schema.String,
      reason: Schema.String,
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
)

const isName = Schema.is(Name)

// What `requestOnce` posts and returns. The value is in none of it.
/** `requestOnce` with a name the store's rule refuses. */
const onceNameInvalid = (name: string) =>
  `${JSON.stringify(name)} cannot be a one-off value's name: it matches [A-Z_][A-Z0-9_]*, is 64 characters at most and is not ${reserved}`

/** `requestOnce` called where the daemon gives it no store, or outside a turn. */
const onceUnavailable = (why: "store" | "turn") =>
  why === "turn"
    ? "requestOnce only works inside a turn, and this call has none. Ask again in the turn that needs the value."
    : "chad cannot take a one-off value here."

/** The request `requestOnce` posts, with the reason the model gave. */
const onceRequest = (name: string, reason: string) =>
  `I need a one-off value for \`${name}\`: ${reason}\nThe button opens a form. chad keeps what you type there in memory for this turn only. It is not saved, and it does not go into this chat.`

/** The label of a one-off request's button. */
const onceButtonLabel = (name: string) => `Enter ${name}`

/** What the request says once the value arrived. */
const onceReceived = (name: string) =>
  `Got \`${name}\`. chad holds it until this turn ends.`

/** What the request says once its deadline passed with no value. */
const onceExpired = (name: string) =>
  `The request for \`${name}\` expired. A value entered now is discarded.`

/** What the request says once the turn that asked was stopped. */
const onceStopped = (name: string) =>
  `The request for \`${name}\` ended with its turn. A value entered now is discarded.`

/** What `requestOnce` returns to the model once the value is ready. It never holds the value. */
const onceReady = (name: string) =>
  `The value is ready under ${name} for the rest of this turn. Pass it to the command that needs it with chad secret run --env VAR=${name} or --stdin ${name}, and never print it.`

/** How `requestOnce` fails when the owner entered nothing in time. */
const onceTimedOut = (name: string, minutes: number) =>
  `The owner entered no value for ${name} within ${minutes} minute${minutes === 1 ? "" : "s"}, so the request expired. If the site still waits for the code, tell the owner and ask again; otherwise start the login over.`

const handlers = tools.toLayer(
  Effect.gen(function* () {
    const chat = yield* Chat.Chat
    // The daemon gives its store only to the bundled plugins.
    const once = yield* Once
    return tools.of({
      requestSecret: ({ name, reason }) =>
        Effect.gen(function* () {
          if (!isName(name) || name === reserved) {
            return yield* Effect.fail(
              `${JSON.stringify(name)} cannot be a secret's name: it matches [A-Z_][A-Z0-9_]*, is 64 characters at most and is not ${reserved}`,
            )
          }
          const { session } = yield* CurrentSession
          yield* chat
            .post(session.thread, {
              markdown: `I need the secret \`${name}\`: ${reason}\nThe button opens a form. What you type there goes into chad's secret store, and not into this chat.`,
              actions: [SecretButton.of(name, { label: `Enter ${name}` })],
            })
            .pipe(
              Effect.mapError(
                (error) => `the chat refused the request: ${error.message}`,
              ),
            )
          return `Posted a button for ${name}. It is not saved yet: end your turn and wait for the owner.`
        }),
      requestOnce: ({ name, reason }) =>
        Effect.gen(function* () {
          if (!isName(name) || name === reserved) {
            return yield* Effect.fail(onceNameInvalid(name))
          }
          if (once === undefined) {
            return yield* Effect.fail(onceUnavailable("store"))
          }
          const current = yield* CurrentSession
          const turn = yield* current.turn
          if (Option.isNone(turn)) {
            return yield* Effect.fail(onceUnavailable("turn"))
          }
          const { session } = current
          const request = once.open({
            session: session.id,
            turn: turn.value.id,
            thread: ChatThread.toString(session.thread),
            name,
          })
          return yield* Effect.gen(function* () {
            const posted = yield* chat
              .post(session.thread, {
                markdown: onceRequest(name, reason),
                actions: [
                  OnceButton.of(request.id, {
                    label: onceButtonLabel(name),
                  }),
                ],
              })
              .pipe(
                Effect.mapError(
                  (error) => `the chat refused the request: ${error.message}`,
                ),
              )
            // The request loses its button however it ends, and an edit the chat refuses leaves it as it is.
            const settle = (markdown: string) =>
              chat
                .edit(session.thread, posted.id, { markdown, actions: [] })
                .pipe(Effect.ignore)
            const arrived = yield* request.submitted.pipe(
              Effect.timeoutOption(once.deadline),
              // A stop interrupts the wait, and the turn's end drops the request.
              Effect.onInterrupt(() => settle(onceStopped(name))),
            )
            // A form that landed as the deadline passed still counts.
            if (Option.isSome(arrived) || once.close(request.id)) {
              yield* settle(onceReceived(name))
              return onceReady(name)
            }
            yield* settle(onceExpired(name))
            return yield* Effect.fail(
              onceTimedOut(
                name,
                Math.max(1, Math.round(Duration.toMinutes(once.deadline))),
              ),
            )
          }).pipe(Effect.ensuring(Effect.sync(() => once.close(request.id))))
        }),
    })
  }),
)

export default Plugin.make(Plugin.toolkit(tools).pipe(Layer.provide(handlers)))
