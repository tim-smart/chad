// The buttons and the form of an MCP server's OAuth sign-in from chat. The tool in index.ts posts the first button.
// chad itself answers each click and the form, and only for the owner: the first button begins the sign-in and posts
// its link, the second opens the form, and the form takes the address the owner's browser ended on. That address
// carries the code of the sign-in, so it goes from the form to chad and into no message.
import { Schema } from "effect"
import { ChatInteraction } from "effect/chat"

/**
 * A server's name in `mcp.json`, as short as a button's value and a form's metadata have to be: Discord gives an id
 * and its value 99 characters together.
 */
export const Server = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
)

/** The button on a request. Its value is the server's name. A click by the owner begins the sign-in. */
export const McpLoginButton = ChatInteraction.button("mcp-login", {
  label: "Sign in",
  style: "primary",
  value: Server,
})

/** The button under the link, which opens the form. */
export const McpLoginPaste = ChatInteraction.button("mcp-login-paste", {
  label: "Paste the address",
  style: "primary",
  value: Server,
})

/** The form. Its metadata is the server's name. */
export const McpLoginForm = ChatInteraction.modal("mcp-login-form", {
  title: "Finish the sign-in",
  submitLabel: "Sign in",
  metadata: Server,
  fields: {
    address: ChatInteraction.textInput({
      label: "The address your browser ended on",
      multiline: true,
    }),
  },
})
