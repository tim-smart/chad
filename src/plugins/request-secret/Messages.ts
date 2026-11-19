// What the plugin's tools post and return, and what they tell the model. It lives beside the plugin, and not in chad's
// `src/Messages.ts`, because the plugin is copied out as an example and may import only chad's public modules and its
// own files.

/** The name kept for writing a literal `${` in configuration, which the store refuses. */
export const reserved = "CHAD_DOLLAR"

/** A name the tools refuse. */
export const nameInvalid = (name: string, what: "a secret" | "a request") =>
  `${JSON.stringify(name)} cannot be ${what}'s name: it matches [A-Z_][A-Z0-9_]*, is 64 characters at most and is not ${reserved}`

/** The chat would not take a request's message. */
export const refused = (message: string) =>
  `the chat refused the request: ${message}`

/** The label of a request's button. */
export const buttonLabel = (name: string) => `Enter ${name}`

export const secretDescription =
  "Ask the owner for a secret that is not stored, such as a password or an API key. It posts a button in this session's thread, and the owner enters the value in a form. The value goes into chad's secret store under name, and never into the chat or your context. reason says what the secret is for, and the owner reads it. It returns once the button is posted, before anything is saved: end your turn. Once the owner saves it, chad starts a turn that says so, and you use the secret by its name."

/** The request `requestSecret` posts. */
export const secretRequest = (name: string, reason: string) =>
  `I need the secret \`${name}\`: ${reason}\nThe button opens a form. What you type there goes into chad's secret store, and not into this chat.`

/** What `requestSecret` returns once the button is posted. */
export const secretPosted = (name: string) =>
  `Posted a button for ${name}. It is not saved yet: end your turn, and chad starts a turn once the owner saves it.`

/** The label of the turn a saved secret starts, which hooks see on `origin.label`. */
export const savedLabel = "secret saved"

/**
 * The prompt of the turn a saved secret starts. It names the secret and never carries its value, and says when a plugin
 * that uses the secret did not reload with it.
 */
export const secretSavedPrompt = (name: string, reloaded: boolean) =>
  `The owner saved the secret \`${name}\` from the button you posted, and chad started this turn to tell you. Its value is in chad's secret store and not here: use it by its name.${reloaded ? "" : " A plugin whose settings name it did not reload with the new value and keeps its previous version: chad posted which one and why in this thread."} Carry on with what you needed it for.`

export const onceDescription =
  "Ask the owner for a value they hand over that is used once and stops working soon after, which chad must not store: a code a site sent by SMS or email, an authenticator code, a device pairing code, or the address the browser ended on after the owner approved an OAuth sign-in. Use it for any such value in place of asking the owner to run a command on the server. Call it when the value is needed, not before. It posts a button in this session's thread and waits, for a few minutes at most, for the owner to enter the value in a form. name labels the request, and reason says what the value is and where the owner finds it; the owner reads both. It returns the value to the calling script only: use it in that same script, by handing it to the command or tool that needs it, and never print it. chad replaces the exact value with a mask in the session's log and in what the script prints, which is all you see of it, and for an address also each value of its query and fragment parameters that is 8 characters or longer, such as its code, as written and decoded. Hand the value to a command in single quotes, never in the double quotes JSON.stringify makes, where the shell expands it. The mask misses a value once it is encoded another way, cut up or written to a file. The value is never saved. Never use this for a password, a key or anything else that stays valid: use requestSecret for a secret chad will need again."

/** `requestOnce` called where the daemon gives it no store, or outside a turn. */
export const onceUnavailable = (why: "store" | "turn") =>
  why === "turn"
    ? "requestOnce only works inside a turn, and this call has none. Ask again in the turn that needs the value."
    : "chad cannot take a one-off value here."

/** The request `requestOnce` posts. */
export const onceRequest = (name: string, reason: string) =>
  `I need a one-off value for \`${name}\`: ${reason}\nThe button opens a form. What you type there goes to the script that asked, for this one use, and is not saved in the secret store.`

/** What the request says once the value arrived. */
export const onceReceived = (name: string) => `Got \`${name}\`.`

/** What the request says once its deadline passed with no value. */
export const onceExpired = (name: string) =>
  `The request for \`${name}\` expired. A value entered now is discarded.`

/** What the request says once the turn that asked was stopped. */
export const onceStopped = (name: string) =>
  `The request for \`${name}\` ended with its turn. A value entered now is discarded.`

/** How `requestOnce` fails when the owner entered nothing in time. */
export const onceTimedOut = (name: string, minutes: number) =>
  `The owner entered no value for ${name} within ${minutes} minute${minutes === 1 ? "" : "s"}, so the request expired. If whatever needs it still waits for the value, tell the owner and ask again; otherwise start over from the step that issued it.`
