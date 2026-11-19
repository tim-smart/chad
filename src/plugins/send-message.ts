// The bundled plugin `send-message`. It uses only the plugin API, and its source is an example the self-edit skill
// points at.
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Chat, ChatMarkdown } from "effect/chat"
import * as Plugin from "../Plugin.ts"
import { CurrentSession } from "../Session.ts"

const tools = Toolkit.make(
  Tool.make("sendMessage", {
    description:
      "Post Markdown to the owner now, as its own message in this session's thread, while you keep working. Use it for a progress note or an early finding during long work. It is not your answer: the turn still ends with your answer, which should not repeat what you already sent.",
    parameters: Schema.String.annotate({ identifier: "markdown" }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
)

const handlers = tools.toLayer(
  Effect.gen(function* () {
    const chat = yield* Chat.Chat
    return tools.of({
      sendMessage: Effect.fnUntraced(function* (markdown) {
        const { session } = yield* CurrentSession
        if (markdown.trim() === "") {
          return yield* Effect.fail("an empty message cannot be sent")
        }
        // Split as an answer is, so a long message goes out in several and then as a file.
        yield* ChatMarkdown.post(session.thread, markdown, {
          overflow: { file: { name: "message.md" } },
        }).pipe(
          Effect.provideService(Chat.Chat, chat),
          Effect.mapError((error) =>
            error.posted.length === 0
              ? `the chat refused the message: ${error.message}`
              : `only part of the message was posted: ${error.message}`,
          ),
        )
        return "sent"
      }),
    })
  }),
)

export default Plugin.make(Plugin.toolkit(tools).pipe(Layer.provide(handlers)))
