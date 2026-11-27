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
  "Ask the owner to save a missing reusable secret under name. Give an owner-facing reason. End your turn when the form button posts. Saving starts a new turn; use the secret by name, never by value."

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
  "Request a short-lived code or OAuth redirect URL only when ready to use it. Use the form instead of asking the owner to run a server command. For reusable secrets, use requestSecret. Give the owner a label (name) and explain where to find the value (reason). The form waits a few minutes and returns the value only to the calling script. Pass it directly to the next tool in that script. For shell commands, use shell-safe single quoting, not JSON.stringify. Never print or save the value; masking cannot protect transformed values or files."

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

export const fillDescription =
  "Fill a browser form field with a stored secret, such as a password, by name. chad passes the value to mcp.browse.fill itself, so your script never sees it. Give the tab and the field's ref from a snapshot, or a selector. Returns what fill returns, with the value masked as [secret NAME]. If the secret isn't stored, ask for it with requestSecret."

/** `fillSecret` called where the daemon gives it no filler. */
export const fillUnavailable = "chad cannot fill a secret here."

/** `fillSecret` called with neither a ref nor a selector. */
export const fillNoField =
  "fillSecret needs the field: pass its ref from a snapshot, or a selector."
