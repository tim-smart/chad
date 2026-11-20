// The bundled plugin `request-mcp-login`. Its tool posts a button in the session's thread, and nothing else: it
// begins no sign-in and sends nothing to the server. The owner's click does, and chad answers it (Form.ts).
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Chat } from "effect/chat"
import * as Plugin from "../../Plugin.ts"
import { CurrentSession } from "../../Session.ts"
import { McpLoginButton, Server } from "./Form.ts"

const tools = Toolkit.make(
  Tool.make("requestMcpLogin", {
    description:
      "Post an owner-only sign-in button for an HTTP server named in mcp.json with an oauth key. End your turn after posting. Use the server once the owner confirms sign-in; never ask for tokens or redirect URLs in chat. If the owner is absent, explain what is needed and stop.",
    parameters: Schema.Struct({
      server: Schema.String,
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
)

const isServer = Schema.is(Server)

const handlers = tools.toLayer(
  Effect.gen(function* () {
    const chat = yield* Chat.Chat
    return tools.of({
      requestMcpLogin: Effect.fnUntraced(function* ({ server }) {
        if (!isServer(server)) {
          return yield* Effect.fail(
            `${JSON.stringify(server)} is too long a name for a button, or empty. Ask the owner to run: chad mcp login ${server}`,
          )
        }
        const { session } = yield* CurrentSession
        yield* chat
          .post(session.thread, {
            markdown: `The MCP server \`${server}\` needs you to sign in. The button starts the sign-in and posts its link here.`,
            actions: [
              McpLoginButton.of(server, { label: `Sign in to ${server}` }),
            ],
          })
          .pipe(
            Effect.mapError(
              (error) => `the chat refused the request: ${error.message}`,
            ),
          )
        return `Posted a sign-in button for ${server}. Nobody is signed in yet: end your turn and wait for the owner.`
      }),
    })
  }),
)

export default Plugin.make(Plugin.toolkit(tools).pipe(Layer.provide(handlers)))
