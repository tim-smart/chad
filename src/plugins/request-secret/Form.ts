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

/** The button on a request. Its value is the secret's name, which the click hands to the form. */
export const SecretButton = ChatInteraction.button("secret", {
  label: "Enter the secret",
  style: "primary",
  value: Name,
})

/**
 * The form a click on the button opens. Its metadata is the name. The note is the one `chad secret set --note` takes,
 * and left empty it keeps the note of a secret that is already stored.
 */
export const SecretForm = ChatInteraction.modal("secret-form", {
  title: "Save a secret",
  submitLabel: "Save",
  metadata: Name,
  fields: {
    value: ChatInteraction.textInput({ label: "Value" }),
    note: ChatInteraction.textInput({
      label: "Note: the site and the username",
      optional: true,
    }),
  },
})
