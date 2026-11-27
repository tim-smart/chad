// The bundled plugin `request-secret`. Each of its tools posts a button in the session's thread, and a click by an
// owner opens a form for a value. `requestSecret` returns at once, and chad saves what the form submits in the secret
// store, so the value never passes through the tool, the script that called it or the model. `requestOnce` waits in
// the turn for the form and returns the value itself, which nothing saves in the store (`src/daemon/Once.ts`).
// `fillSecret` posts nothing: the daemon puts a stored secret into a page's field through browse, so the script that
// calls it never holds the value (`src/daemon/Fill.ts`).
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Chat, ChatThread } from "effect/chat"
import * as Plugin from "../../Plugin.ts"
import { CurrentSession } from "../../Session.ts"
import { Name, OnceButton, SecretButton, secretRequest } from "./Form.ts"
import * as Messages from "./Messages.ts"
import { Once } from "./Once.ts"

const tools = Toolkit.make(
  Tool.make("requestSecret", {
    description: Messages.secretDescription,
    parameters: Schema.Struct({
      name: Schema.String,
      reason: Schema.String,
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
  Tool.make("requestOnce", {
    description: Messages.onceDescription,
    parameters: Schema.Struct({
      name: Schema.String,
      reason: Schema.String,
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
  Tool.make("fillSecret", {
    description: Messages.fillDescription,
    parameters: Schema.Struct({
      name: Schema.String,
      tab: Schema.Union([Schema.String, Schema.Number]),
      ref: Schema.optionalKey(Schema.String),
      selector: Schema.optionalKey(Schema.String),
    }),
    success: Schema.Unknown,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
)

const isName = Schema.is(Name)

const checkName = (name: string, what: "a secret" | "a request") =>
  !isName(name) || name === Messages.reserved
    ? Effect.fail(Messages.nameInvalid(name, what))
    : Effect.void

const handlers = tools.toLayer(
  Effect.gen(function* () {
    const chat = yield* Chat.Chat
    // The daemon gives its store only to the bundled plugins.
    const once = yield* Once
    return tools.of({
      requestSecret: Effect.fnUntraced(function* ({ name, reason }) {
        yield* checkName(name, "a secret")
        const { session } = yield* CurrentSession
        yield* chat
          .post(session.thread, {
            markdown: Messages.secretRequest(name, reason),
            actions: [
              SecretButton.of(secretRequest(name, session.id), {
                label: Messages.buttonLabel(name),
              }),
            ],
          })
          .pipe(Effect.mapError((error) => Messages.refused(error.message)))
        return Messages.secretPosted(name)
      }),
      requestOnce: Effect.fnUntraced(function* ({ name, reason }) {
        yield* checkName(name, "a request")
        if (once === undefined) {
          return yield* Effect.fail(Messages.onceUnavailable("store"))
        }
        const current = yield* CurrentSession
        if (Option.isNone(yield* current.turn)) {
          return yield* Effect.fail(Messages.onceUnavailable("turn"))
        }
        const { session } = current
        const request = once.open(
          ChatThread.toString(session.thread),
          session.id,
        )
        return yield* Effect.gen(function* () {
          const posted = yield* chat
            .post(session.thread, {
              markdown: Messages.onceRequest(name, reason),
              actions: [
                OnceButton.of(request.id, {
                  label: Messages.buttonLabel(name),
                }),
              ],
            })
            .pipe(Effect.mapError((error) => Messages.refused(error.message)))
          // The request loses its button however it ends, and an edit the chat refuses leaves it as it is.
          const settle = (markdown: string) =>
            chat
              .edit(session.thread, posted.id, { markdown, actions: [] })
              .pipe(Effect.ignore)
          const arrived = yield* request.submitted.pipe(
            Effect.timeoutOption(once.deadline),
            // A stop interrupts the wait, and the request ends with it.
            Effect.onInterrupt(() => settle(Messages.onceStopped(name))),
          )
          // A form that landed as the deadline passed still counts.
          const value = Option.isSome(arrived)
            ? arrived.value
            : once.close(request.id)
          if (value !== undefined) {
            yield* settle(Messages.onceReceived(name))
            return value
          }
          yield* settle(Messages.onceExpired(name))
          return yield* Effect.fail(
            Messages.onceTimedOut(
              name,
              Math.max(1, Math.round(Duration.toMinutes(once.deadline))),
            ),
          )
        }).pipe(Effect.ensuring(Effect.sync(() => once.close(request.id))))
      }),
      fillSecret: Effect.fnUntraced(function* ({ name, ...target }) {
        yield* checkName(name, "a secret")
        if (once === undefined) {
          return yield* Effect.fail(Messages.fillUnavailable)
        }
        if (target.ref === undefined && target.selector === undefined) {
          return yield* Effect.fail(Messages.fillNoField)
        }
        const { session } = yield* CurrentSession
        return yield* once.fill(session.id, name, target)
      }),
    })
  }),
)

export default Plugin.make(Plugin.toolkit(tools).pipe(Layer.provide(handlers)))
