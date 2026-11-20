// The button and the form that save a secret from chat. The tool in index.ts posts the button. chad itself answers
// the click with the form and saves what the form submits, the way `chad secret set` does, so the value goes from the
// form to the secret store and nowhere else: not into a message, a script, the session's history or the log.
import { Schema } from "effect"
import { ChatInteraction } from "effect/chat"

/** A name the secret store holds: the pattern and the length `chad secret set` takes. */
export const Name = Schema.String.check(
  Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/),
  Schema.isMaxLength(64),
)

/**
 * The start of a session's id, without its dashes, that a request carries to name the session that asked. A whole id
 * would not fit in the 100 characters Discord gives a button's or a form's id, and 12 random hex digits tell one
 * thread's sessions apart.
 */
export const sessionTag = (session: string) =>
  session.replaceAll("-", "").slice(0, 12)

/**
 * What a request's button and its form carry: the secret's name, a `/`, and the tag of the session that asked, which
 * the turn a saved secret starts is held to. A button posted before requests carried the tag has the name alone.
 */
export const SecretRequest = Schema.String.check(
  Schema.isPattern(/^[A-Z_][A-Z0-9_]{0,63}(?:\/[0-9a-f]{12})?$/),
)

/** What a request of a secret in a session carries. */
export const secretRequest = (name: string, session: string) =>
  `${name}/${sessionTag(session)}`

/** The name and the session's tag, if any, of what a request carries. */
export const parseSecretRequest = (value: string) => {
  const at = value.indexOf("/")
  return at === -1
    ? { name: value, tag: undefined }
    : { name: value.slice(0, at), tag: value.slice(at + 1) }
}

/** The button on a request. Its value is what the request carries, which the click hands to the form. */
export const SecretButton = ChatInteraction.button("secret", {
  label: "Enter the secret",
  style: "primary",
  value: SecretRequest,
})

/**
 * The form a click on the button opens. Its metadata is what the request carries. The note is the one
 * `chad secret set --note` takes, and left empty it keeps the note of a secret that is already stored.
 */
export const SecretForm = ChatInteraction.modal("secret-form", {
  title: "Save a secret",
  submitLabel: "Save",
  metadata: SecretRequest,
  fields: {
    value: ChatInteraction.textInput({ label: "Value" }),
    note: ChatInteraction.textInput({
      label: "Note: the site and the username",
      optional: true,
    }),
  },
})

/** The id of a one-off request, which its button and its form carry. The value itself is never in either. */
export const RequestId = Schema.String.check(Schema.isMaxLength(64))

/**
 * The button on a `requestOnce` request. chad answers its click with the form only while the request waits, and keeps
 * what the form submits in the daemon's memory for the session that asked, not in the secret store.
 */
export const OnceButton = ChatInteraction.button("once", {
  label: "Enter the value",
  style: "primary",
  value: RequestId,
})

/**
 * The form a click on a one-off request opens. Its metadata is the request's id, and it has no note. The field is
 * multiline, as the MCP sign-in's is, so an address of a few hundred characters shows whole on a phone. It sets no
 * maximum, which leaves Discord's 4000 characters.
 */
export const OnceForm = ChatInteraction.modal("once-form", {
  title: "Enter a one-off value",
  submitLabel: "Send",
  metadata: RequestId,
  fields: {
    value: ChatInteraction.textInput({ label: "Value", multiline: true }),
  },
})
