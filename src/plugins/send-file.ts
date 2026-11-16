// The bundled plugin `send-file` (DIS-65 to DIS-69). It uses only the plugin API, and its source is the example the
// self-edit skill points at.
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Chat } from "effect/chat"
import * as Plugin from "../Plugin.ts"
import { CurrentSession } from "../Session.ts"

/** The largest file Discord takes from a bot (DIS-67). */
const limit = 10 * 1024 * 1024

/** A few content types by extension. Anything else is sent as bytes, and Discord still shows its name. */
const types: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
}

const tools = Toolkit.make(
  Tool.make("sendFile", {
    description:
      "Send any file you can read to the owner, as its own message in this session's thread. A relative path is relative to your working directory. caption is the text of the message.",
    parameters: Schema.Struct({
      path: Schema.String,
      caption: Schema.optionalKey(Schema.String),
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
)

const handlers = tools.toLayer(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const chat = yield* Chat.Chat
    return tools.of({
      sendFile: ({ path: given, caption }) =>
        Effect.gen(function* () {
          const { session } = yield* CurrentSession
          // Any path the agent can read, a relative one from the directory its scripts run in (DIS-68).
          const file = path.resolve(session.directory, given)
          const info = yield* fs
            .stat(file)
            .pipe(
              Effect.mapError(
                (error) => `cannot read ${file}: ${error.message}`,
              ),
            )
          if (info.type !== "File") {
            return yield* Effect.fail(`${file} is not a file`)
          }
          if (Number(info.size) > limit) {
            return yield* Effect.fail(
              `${file} is ${Number(info.size)} bytes, and a file over 10 MiB cannot be sent`,
            )
          }
          const content = yield* fs
            .readFile(file)
            .pipe(
              Effect.mapError(
                (error) => `cannot read ${file}: ${error.message}`,
              ),
            )
          const name = path.basename(file)
          // The file is its own message, posted now, and the answer comes later (DIS-66, DIS-105, DIS-107).
          yield* chat
            .post(session.thread, {
              markdown: caption ?? "",
              files: [
                {
                  name,
                  contentType:
                    types[path.extname(name).toLowerCase()] ??
                    "application/octet-stream",
                  content,
                },
              ],
            })
            .pipe(
              Effect.mapError(
                (error) => `the chat refused ${name}: ${error.message}`,
              ),
            )
          return `sent ${name}`
        }),
    })
  }),
)

export default Plugin.make(Plugin.toolkit(tools).pipe(Layer.provide(handlers)))
