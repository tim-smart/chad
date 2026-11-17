// The bundled plugin `request-secret`. Its tool posts a button in the session's thread. A click opens a form for the
// secret's value, and chad saves what the form submits, so the value never passes through the tool, the script that
// called it or the model.
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Chat } from "effect/chat"
import * as Plugin from "../../Plugin.ts"
import { CurrentSession } from "../../Session.ts"
import { Name, SecretButton } from "./Form.ts"

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
)

const isName = Schema.is(Name)

const handlers = tools.toLayer(
  Effect.gen(function* () {
    const chat = yield* Chat.Chat
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
    })
  }),
)

export default Plugin.make(Plugin.toolkit(tools).pipe(Layer.provide(handlers)))
