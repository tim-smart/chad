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
      "Ask the owner to sign chad in to an MCP server that needs login: an HTTP server with an \"oauth\" key in mcp.json. server is its name there. It posts a button in this session's thread. The owner presses it, approves in a browser, and gives chad the address the browser ended on through a form, so no token and no address goes into the chat or your context. It returns once the button is posted, before anyone signed in: end your turn, and use the server's tools once the owner says it is signed in. Only the owner can sign in, so in a session with no owner to press the button, say what is needed and stop.",
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
      requestMcpLogin: ({ server }) =>
        Effect.gen(function* () {
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
