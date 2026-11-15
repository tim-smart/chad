# Credential tools

This part covers how a tool that has to sign in somewhere gets a stored login or a one-off code from the owner. It specifies the `chad secret` commands, the TOTP kind of secret, the `/secret` chat command, the Enter button and its modal, the bundled `credentials` skill and the browser sidecar that the skill's recipes assume. It also states what chad does and does not promise about keeping a stored value away from the model. It leans on 10-cli.md for the socket, the exit codes and the `CHAD_SESSION` marker, on 02-storage.md for where the secret file sits, on 03-sessions-and-turns.md for chat commands and steering, on 04-discord.md for buttons, on 11-settings.md and 12-skills-and-mcp.md for `${NAME}` expansion, on 16-failures-logs-status.md for the log, and on 17-testing.md for the tests.

Terms used here. A stored value is the value of a secret in chad's secret store. TOTP is the time-based one-time password scheme of RFC 6238, in which a short code is computed from a stored seed and the clock, and a window is the period (30 seconds by default) during which one code is valid. CDP is the Chrome DevTools Protocol, the wire protocol a tool uses to drive a Chromium browser. The stored form of `chad secret request` asks the owner for a value that chad then saves under a name. The code form (`--code`) asks for a one-off code that is handed to the script and never saved.

## Scope

chad ships the commands that hold logins and fetch codes. It ships nothing that signs in. The owner adds a browser tool, and that tool uses these commands.

- **CRED-1** v1 ships the credential tools and no browser. chad supplies no browser as an MCP server, a skill or a bundled plugin, and the chad image never carries one.
- **CRED-2** The owner adds a browser tool, which is either Playwright MCP through `mcp.json` or agent-browser as a command line tool installed on the volume. The tool drives a Chromium that runs in a second container (a sidecar) over CDP.
- **CRED-3** An image the owner derives from chad's, with a browser added, is the other allowed way to supply a browser.
- **CRED-4** The agent has no sudo and no apt in the container, so a tool that signs in is in the image, installable through npm or uv, or a single binary in `~/.local/bin`.
- **CRED-5** Every credential tool is a `chad` CLI command in the core. The plugin API gains no call for asking the owner or for reading a secret.
- **CRED-6** chad binds no secret to a site or to a session. Every session, sub-agent and background task can use every secret.
- **CRED-7** The agent may run every `chad secret` command.

## What chad promises about stored values

clanka's agent works by writing scripts. A script's source and its console output both enter the session's history, the status message in Discord shows the source, and clanka's built-in handlers print a line such as `Calling "bash"` with the full command into that output. A value that appears in a script or in what a command prints is therefore in Discord, in the database and in the model's context. The credential commands take a secret's name wherever a value would otherwise go.

- **CRED-8** chad's commands and the `credentials` skill's recipes never print a stored value.
- **CRED-9** A stored value used through these commands is not in a script's source, not in an owner message and not in what a chad command prints. The `Calling "bash"` line of such a command shows names only.
- **CRED-10** The only thing a chad command prints that is derived from a secret is the TOTP code from `chad secret code`. The seed is never printed.
- **CRED-11** There is no `chad secret get`. This rests on chad's commands never printing a stored value, and nothing else stands behind it.
- **CRED-12** chad masks nothing. History rows, the `turns` table including `Failed.reason`, the log, the status message, everything chad posts to chat and the messages an `afterTurn` hook receives are written and sent as they are. There is no `<secret:NAME>` replacement, no wrap of clanka's `AgentExecutor`, and chad does not rewrite rows it has already stored.
- **CRED-13** The test plan holds no test that a value a script printed is absent from chad's outputs. Its one check on stored values tests CRED-8. It stores a canary value, runs every `chad` command and every recipe, and looks for the value in every output and in the log (see 17-testing.md).
- **CRED-105** chad logs each script's source and output, unmasked, to `logs/chad.log` and to the container's stdout. A value a script printed therefore goes wherever the container's logs are shipped (see 16-failures-logs-status.md).
- **CRED-14** chad does not promise a stored value against an agent that goes looking. The agent can read `secrets/secrets.json` with clanka's `readFile`, a browser that has typed a password can be asked for it, `chad secret run -- printenv` prints a value, and a value handed to an MCP server through `mcp.json` is in that server's `/proc/<pid>/environ`. The spec states this in plain words.
- **CRED-15** When the owner stores a TOTP seed next to a password, chad holds both factors of that login, and anyone who gets into the container has both. chad does nothing to prevent this. It is the owner's trade, and the spec and the skill say so in plain words.

One fact from the prototype belongs with CRED-14. clanka saves a command output longer than 30,000 characters to a temporary file and tells the model the path. chad does not write that file. It is mode 644 and outside the data volume, so a value that a script printed into a long output is in it.

## The secret store

A login is not a record of its own. It is plain named secrets, for example one for a password and one for a TOTP seed, with the site and the username written in a note.

- **CRED-16** Secrets are named entries in `secrets/secrets.json` on the data volume, mode 0600 (see 02-storage.md). A login is plain named secrets in that file.
- **CRED-17** Each entry holds a value, a kind that is `plain` or `totp`, an optional note and the time it was saved.
- **CRED-18** A secret's name matches `[A-Z_][A-Z0-9_]*` and is 64 characters at most. `chad secret set`, `chad secret request` and `/secret` all enforce it.
- **CRED-19** `chad secret set` refuses the name `CHAD_DOLLAR`, which is reserved for writing a literal `${` in configuration (see 11-settings.md).
- **CRED-20** By convention the note holds the site and the username of the login the secret belongs to.
- **CRED-21** A `totp` entry holds a TOTP seed. `chad secret set NAME --totp` takes the seed as base32 or as an `otpauth://` URI and refuses what does not decode. The code is 6 digits, SHA-1 and 30 seconds unless the URI says otherwise.

The store and the TOTP code as the prototype built them. The prototype also accepted 7 or 8 digits and SHA-256 or SHA-512 from the URI, stored the seed in canonical base32 (upper case, no spaces, no padding), and passed all 18 vectors of RFC 6238 appendix B.

```ts
export interface Totp {
  readonly digits: number
  readonly period: number
  readonly algorithm: "sha1" | "sha256" | "sha512"
}
export interface Entry {
  /** A plain value, or the base32 seed in canonical spelling (upper case, no spaces, no padding). */
  readonly value: string
  readonly kind: "plain" | "totp"
  readonly note?: string | undefined
  /** ISO time of the save. A click on an old button is compared with it. */
  readonly date: string
  readonly totp?: Totp | undefined
  // adjusted: TIM-554 decision 2 (the prototype's `typed` field existed only for masking and is gone)
}
/** The content of secrets/secrets.json, keyed by name. */
export type Store = Record<string, Entry>

export const NAME = /^[A-Z_][A-Z0-9_]*$/ // adjusted: TIM-554 decision 6
export const NAME_MAX = 64 // adjusted: TIM-554 decision 6

/** base32, or an otpauth:// URI. Gives the reason when it does not decode. */
export declare const parseTotp: (input: string) => { seed: string; totp: Totp } | { error: string }

/** The code for the current window. Under 5 seconds left: waits for the next window first. */
export declare const currentCode: (entry: Entry) => Promise<{ code: string; left: number; waited: number }>
```

## Commands

```
chad secret set <NAME> [--totp] [--note <text>]      the value comes from stdin or a hidden prompt
chad secret list [--json]
chad secret rm <NAME>
chad secret run [--env VAR=NAME]... [--stdin NAME] -- <command> [args]
chad secret code <NAME>
chad secret request <NAME> [--totp] [--note <text>] [-m "<why>"] [--no-wait]
chad secret request --code -m "<why>"
```

The exit codes 0, 1, 2 and 4 mean what 10-cli.md says they mean for every command. `chad secret run` adds 125, 126 and 127 and passes its child's code through.

## Saving, listing and removing

- **CRED-22** `chad secret set <NAME>` takes the value from stdin or from a hidden prompt, and never as an argument.
- **CRED-23** `set` on a name that already exists replaces the value and the kind and says so by printing `Replaced NAME` in place of `Saved NAME`.
- **CRED-24** `set` on an existing name keeps the note unless `--note` is given. `--note ""` clears it.
- **CRED-25** With the daemon running, `set` sends the value to the daemon, which saves it through its queue, reloads the plugins whose settings name the secret, rebuilds the MCP layer if `mcp.json` names it, and prints what was reloaded. With no daemon the CLI writes the file itself. The detail is in 10-cli.md and 08-apply-and-swap.md.
- **CRED-26** `chad secret list` prints the name, kind, note and date of each secret, and no value. It takes `--json` (see 10-cli.md).
- **CRED-27** `chad secret rm <NAME>` deletes the secret and reloads what names it, as `set` does.
- **CRED-106** A `chad secret rm` that removed the secret when run from a session posts one subtext line in that session's thread. That includes one that exits 1 because a plugin kept its previous version, and the line then names those plugins (see 08-apply-and-swap.md). Run from the owner's shell it posts nothing, and one that changed nothing posts nothing (see 16-failures-logs-status.md).
- **CRED-111** The reload after a secret is saved or removed leaves out a plugin that is off (see 11-settings.md).
- **CRED-112** The reload after a secret is saved or removed also tries a plugin that a boot skipped, when that plugin's settings name the secret (see 11-settings.md and 09-repo-and-recovery.md).

## Giving a value to a command

`chad secret run` is how a value reaches a tool. It has to be a CLI command and cannot be a clanka tool, because only the process that spawns a child can put a value in that child's environment.

- **CRED-28** `chad secret run --env VAR=NAME [--stdin NAME] -- <command>` runs the command with the value of secret NAME in the environment variable VAR. `--env` can be given more than once.
- **CRED-29** `--stdin NAME` writes the value to the command's stdin with no trailing newline and then closes stdin.
- **CRED-30** For `run` and `code` the CLI reads `secrets/secrets.json` itself, whether or not a daemon is running.
- **CRED-31** A name that is not in the store makes `run` exit 125 with `chad secret run: no secret named NAME` on stderr, and the command is not started.
- **CRED-32** Otherwise the command's own exit code is `run`'s exit code. The prototype saw 7 passed through, 143 for a command ended by SIGTERM and 127 for a command that does not exist.
- **CRED-33** For a TOTP secret, `run` gives the current code in place of the seed.
- **CRED-113** Bad usage of `run`, which includes a bad `--env` pair, exits 125 and not the 2 that 10-cli.md gives bad usage in every other command. `run` passes its child's code through, so its own failures use codes a child rarely returns.
- **CRED-114** A command that is not found makes `run` exit 127, which is the code a shell gives for it.
- **CRED-115** A command that is found but is not executable makes `run` exit 126.

## TOTP codes

- **CRED-34** `chad secret code NAME` prints the current code and the seconds left in its window. The code is alone on stdout, so `$(chad secret code NAME)` is the code, and the seconds left go to stderr as `<n>s left`.
- **CRED-35** `chad secret code` is refused for a secret that is not TOTP. It exits 1 with `chad secret code: NAME is not a TOTP secret`.
- **CRED-36** With under 5 seconds left in the window, `code` and `run` both wait for the next window and give that window's code.
- **CRED-37** `${NAME}` naming a TOTP secret in `mcp.json` or `chad.json` fails the apply.
- **CRED-38** `chad secret set NAME --totp` is refused while the live `mcp.json` or `chad.json` names NAME, and the secret is left as it was.
- **CRED-116** For `chad.json`, the checks of CRED-37 and CRED-38 read every plugin's entry, whether that plugin is on or off (see 11-settings.md).

## Asking the owner for a secret

`chad secret request` lets a script ask the owner for a value without the value passing through the conversation. The owner types it into a Discord modal, which is a form that opens over the chat and whose content is not a channel message.

- **CRED-39** `chad secret request NAME [--totp] [--note] [-m "<why>"]` posts a message with an Enter button in the thread of the session that ran the command. The session is the one named by `CHAD_SESSION` (see 10-cli.md).
- **CRED-40** The message reads as the agent asking. It names the session and quotes the `-m` text as the agent's words.
- **CRED-41** A request for a name that already exists is allowed, since a wrong password is the usual reason for one.
- **CRED-42** The stored form waits for the secret to be saved, then prints `Saved NAME` and exits 0.
- **CRED-43** `--no-wait` posts the button and returns at once. It exists for the stored form only.
- **CRED-117** A `--note` given to `chad secret request` is stored with the secret when the owner's value is saved. It follows CRED-24, so a note that is given replaces the stored one and a request without `--note` keeps the stored one.

The message texts, from the prototype. The parts in square brackets appear only when they apply.

```
The agent in session <session id> asks for a secret named <NAME>[ (a TOTP seed)][ (<note>)].
[It says: "<-m text>"]
Press Enter to type it.
```

```
The agent in session <session id> asks for a one-off code.
[It says: "<-m text>"]
Press Enter to type it.
```

## One-off codes

- **CRED-44** `chad secret request --code -m "<why>"` posts the same Enter button, waits, and prints what the owner typed on stdout. Nothing is stored. After the submit the message is edited to `Code received` and the button is removed.
- **CRED-45** The code form is how an SMS code, an email code or "type anything once you approved it on your phone" reaches a script without a new turn. An ordinary owner reply in the thread stays the fallback.

## The Enter button and the modal

- **CRED-46** v1 has two buttons, Stop and Enter, and one modal (see 04-discord.md). The Enter button is posted by `chad secret request` and by `/secret NAME`.
- **CRED-47** The button's id carries the secret's name and the kind (plain, TOTP or one-off code). A click is handled from the id alone, so a button the daemon no longer remembers still works.
- **CRED-48** A click from anyone who is not an owner is ignored. No modal opens, nothing is stored and the button stays.
- **CRED-118** chad answers a click from someone who is not an owner with a plain acknowledgement and posts nothing (see 04-discord.md).
- **CRED-107** A modal submit from anyone who is not an owner is ignored. Nothing is stored and no code reaches a script.
- **CRED-49** An owner's click opens a modal with one text field. The modal is the reply to the click, so it is sent inside Discord's 3 seconds. The share of that time a handler gets is in 04-discord.md.
- **CRED-50** The modal's field is not masked, because Discord has no masked input.
- **CRED-51** On a submit chad checks the input, replies to the modal, saves the value, and then edits the message. The reply does not wait for the daemon's queue. In the prototype a submit that waited on a held queue was late at 3001 ms and the typed value was lost.
- **CRED-52** A TOTP seed that does not decode is refused inside the modal as an error on the field, and the button stays.
- **CRED-53** The save takes the same path as `chad secret set` through the daemon's queue, so whatever names the secret reloads. The message is then edited to `Saved NAME` and the button is removed.
- **CRED-54** If the save fails after the reply, the message says so and the button stays.
- **CRED-55** A stop of the daemon between the reply and the save loses the typed value.

The interaction definitions from the prototype, written against effect/chat's `ChatInteraction`. For a one-off code the `n` field holds the id of the pending request in place of a name.

```ts
const Ref = Schema.Struct({ n: Schema.String, k: Schema.Literals(["plain", "totp", "code"]) })
const Enter = ChatInteraction.button("enter", { label: "Enter", style: "primary", value: Ref })
const EnterModal = ChatInteraction.modal("enter-modal", {
  title: "Enter a secret",
  metadata: Ref,
  fields: { value: ChatInteraction.textInput({ label: "Value" }) }
})
/** The definition's title and label are fixed, so the reply is built by hand to name the secret. Discord: title 45, label 45. */
const openModal = (ref: typeof Ref.Type): ChatInteraction.OpenModal => {
  const opened = EnterModal.open({ metadata: ref })
  const label = ref.k === "code" ? "One-off code" : ref.k === "totp" ? ref.n + " (TOTP seed or otpauth:// URI)" : ref.n
  return { ...opened, modal: { ...opened.modal, elements: opened.modal.elements.map((e: any) => (e._tag === "TextInput" ? { ...e, label: label.slice(0, 45) } : e)) } }
}
```

## Waiting, replies and stops

- **CRED-56** Both forms of `request` wait 5 minutes. The length is a constant and has no flag.
- **CRED-57** When the code form times out, its message is edited to `Timed out`, its button is removed, and `request` exits 1.
- **CRED-58** When the stored form times out, `request` exits 1 and the button stays, since a late submit is still useful.
- **CRED-59** An owner message in the thread ends every request pending there at once. `request` exits 1 with `chad secret request: owner replied in chat instead`, and the message then steers the turn as usual (see 03-sessions-and-turns.md).
- **CRED-60** A code-form message ended by an owner reply is edited to `Answered in chat` and its button is removed. A stored-form button stays, as on a timeout.
- **CRED-61** `/stop` kills the `request` command. The daemon notices the dropped client and edits a code-form message to `Cancelled`, with the button removed. A stored-form button stays.
- **CRED-62** chad leaves clanka's `scriptTimeout` limit unset. Anything that sets it later uses 330 seconds or more, because a shorter limit cuts the script around a 5 minute wait.

What a request message becomes:

| Event | Stored form | Code form |
| --- | --- | --- |
| The owner submits the modal | Edited to `Saved NAME`, button removed | Edited to `Code received`, button removed |
| 5 minutes pass | Unchanged, button stays | Edited to `Timed out`, button removed |
| The owner sends a message in the thread | Unchanged, button stays | Edited to `Answered in chat`, button removed |
| `/stop`, or the client drops for another reason | Unchanged, button stays | Edited to `Cancelled`, button removed |
| The name is saved by another path | Edited to `Saved NAME`, button removed | Does not apply |
| The owner clicks a button whose request no longer exists | The modal opens as for any forgotten button (CRED-71 and CRED-72) | Edited to `Cancelled`, button removed |

## When no owner is present

A request only makes sense to wait on when somebody is there to answer it. chad decides this from how the turn started.

- **CRED-63** No owner is present in a turn that a plugin started, and in a background task or sub-agent that outlived its turn.
- **CRED-64** With no owner present the stored form posts the button with a ping of the owner and exits 1 without waiting.
- **CRED-65** With no owner present the code form is refused and posts nothing.
- **CRED-66** With `CHAD_SESSION` unset or set to `daemon`, `request` is refused with exit 2 and its message points at `chad secret set`. The code is 2 and not 1 because exit 1 already means that the owner replied or that no owner is present, which the agent has to tell apart from a refusal. The variable is easy to unset, so this is a convenience and not a guard.
- **CRED-119** When the plugin's turn carries a `mention` (see 06-plugin-api.md), the ping of CRED-64 names that user.
- **CRED-120** Otherwise the ping of CRED-64 names every owner of the connection that the thread belongs to.

## Repeat requests and forgotten buttons

- **CRED-67** The daemon remembers each unused stored-form button by name and thread. The memory is held in the daemon's memory only.
- **CRED-68** A repeat request for the same name in the same thread posts nothing. With no owner present it exits 1 with `chad secret request: already asked at <time>`.
- **CRED-69** In an owner's turn a repeat request waits on the existing button.
- **CRED-70** When a name is saved by any path, every remembered button for it, in every thread, is edited to `Saved NAME` and its button removed, and every request waiting on it returns as saved.
- **CRED-71** A daemon restart forgets the buttons. The next request for the name posts one more button, and a forgotten button still works because its click is handled from its id.
- **CRED-72** On a click chad compares the time the secret was saved with the time of the button's message. If the secret was saved later, chad edits the message to `Saved NAME` and opens no modal, so an old button cannot replace a newer value.
- **CRED-121** A click on a code-form button whose request no longer exists, which is possible after a daemon restart, opens no modal. chad edits the message to `Cancelled` and removes the button, because no script is left to receive the code.
- **CRED-122** When chad retires a button on a click without opening a modal (CRED-72 and CRED-121), Discord gets its answer to the click inside 3 seconds.
- **CRED-123** `chad secret rm` does nothing to the remembered buttons for that name or to the requests waiting on it. The buttons stay and the requests keep waiting.
- **CRED-131** When several requests for one name in one thread share a button (CRED-68 and CRED-69), the note stored with the owner's value is the note of the latest of those requests that gave one. A repeat request without `--note` leaves a note that an earlier request gave as it is, as `chad secret set` without `--note` does (CRED-24).
- **CRED-132** A value that arrives through a button the daemon has forgotten (CRED-71) is saved as a request without `--note` saves it, so a note already stored with the name is kept. The note of the request that posted the button is lost with the daemon's memory, because the daemon holds it beside the remembered button and writes nothing to disk for it, and the button's id carries no note (CRED-47).

## The /secret chat command

- **CRED-73** `/secret NAME` and `/secret NAME totp` in chat post the Enter button for that name in the thread. The message reads `Press Enter to save a secret named NAME.`
- **CRED-74** `/secret` alone posts what `chad secret list` prints.
- **CRED-75** `/secret` is plain text like `/new`, follows the same mention rule, never reaches the session and starts no turn. It joins `/safe`, `/model`, `/new`, `/stop` and `/status` as a chat command (see 03-sessions-and-turns.md).
- **CRED-76** `/secret` works when chad is logged out of the model and when it is in safe mode. It is the only way to save a secret from a phone in either state.
- **CRED-124** When an unused button for NAME is already in the thread, `/secret NAME` posts no second button.
- **CRED-125** In that case `/secret NAME` answers with one line that points at the existing message. On Discord the line carries a link to that message.
- **CRED-126** In a plain channel that has no session, `/secret` answers in the channel and opens no thread, as every chat command does (see 03-sessions-and-turns.md).

## A password typed into the chat

- **CRED-77** The agent never asks for a password as a chat message.
- **CRED-78** If the owner pastes a password anyway, the agent does not save it with `chad secret set`, because the script would carry the value and the status message would post it back. The agent says the value is in the conversation, asks the owner to change the password and save the new one with `/secret NAME`, and suggests deleting the message.
- **CRED-79** Changing the password is the fix for a value that reached the conversation. `/new` only takes the value out of the live context, because the stored rows stay for 30 days after the reset and are in backups.

## What the daemon returns and what it logs

- **CRED-80** No RPC call returns a stored value. The one call that returns something the owner typed is the code form of `request`, where the typed code is that call's result and was never stored.
- **CRED-81** `chad secret set` sends a value to the daemon as the payload of its call. Nothing comes back but flags and the names of what was reloaded.
- **CRED-82** The daemon logs no RPC request body, no RPC response body and no interaction payload. A modal submit's raw payload holds the typed value, so it is never logged.
- **CRED-130** When the daemon finishes a `chad secret set` or a `chad secret rm`, it writes the log event `command.ran` (see 16-failures-logs-status.md). The line carries the command, the caller, which is the owner, a session id or the daemon, and the outcome. It never carries a secret's value.
- **CRED-133** Every save of a secret through the Enter modal writes `command.ran` as well. The modal's handler writes the line when the save finishes, whichever command posted the button and whether or not that command is still running. A save that follows `chad secret request --no-wait`, `/secret NAME`, a request that timed out or a forgotten button (CRED-71) has no command left to finish, so this line is the only trace of the change. The line names the command as the save of a secret and the caller as the owner. It carries the outcome, which for a save that fails after the modal's reply (CRED-54) is the failure, and it never carries the value.
- **CRED-134** A stored-form `chad secret request` that is waiting when its secret is saved writes its own `command.ran` when it returns as saved, with its session as the caller, as CRED-130 has for `chad secret set`. A save through the modal while one request waits therefore leaves two lines, one for the owner's save (CRED-133) and one for the agent's command. The modal's handler never checks whether a command is waiting.
- **CRED-135** A modal submit that saves nothing writes no line under CRED-133. That covers a one-off code, which is handed to the script and stored nowhere (CRED-44), a TOTP seed that is refused inside the modal (CRED-52), and a submit from someone who is not an owner (CRED-107).

The three calls as the prototype defined them. The RPC group, the socket and the session header belong to 10-cli.md.

```ts
/** A call that ends the command with a non-zero exit and a line on stderr. */
export const Ended = Schema.Struct({ _tag: Schema.Literal("Ended"), exit: Schema.Number, message: Schema.String })

// The one call that carries a value to the daemon. Nothing comes back but flags.
Rpc.make("SecretSet", {
  // note: undefined keeps the stored note, "" clears it // adjusted: TIM-554 decision 9
  payload: { name: Schema.String, value: Schema.String, totp: Schema.Boolean, note: Schema.optional(Schema.String) },
  success: Schema.Struct({ replaced: Schema.Boolean, restarted: Schema.Array(Schema.String), buttons: Schema.Number }), // adjusted: TIM-554 decision 2 (no `short` flag)
  error: Ended
})
Rpc.make("SecretRm", { payload: { name: Schema.String }, success: Schema.Boolean, error: Ended })
// Returns no stored value. `code` is what the owner typed for --code and is stored nowhere.
Rpc.make("SecretRequest", {
  payload: {
    name: Schema.optional(Schema.String),
    kind: Schema.Literals(["plain", "totp", "code"]),
    note: Schema.optional(Schema.String),
    why: Schema.optional(Schema.String),
    noWait: Schema.Boolean
  },
  success: Schema.Struct({ result: Schema.Literals(["saved", "code", "asked"]), code: Schema.optional(Schema.String), message: Schema.String }),
  error: Ended
})
```

## Command messages

The wordings below are the prototype's. The ones a rule above quotes are decided. The rest were not discussed in a ticket (see Gaps).

| Command | Case | Output | Exit |
| --- | --- | --- | --- |
| `set` | Saved, new name | `Saved NAME`, followed by `, restarted <names>` when something reloaded | 0 |
| `set` | Saved, existing name | `Replaced NAME`, with the same suffix | 0 |
| `set` | Name does not match | `chad secret set: the name must match <pattern>` | 2 |
| `set` | Empty value | `chad secret set: no value on stdin` | 2 |
| `set --totp` | Seed does not decode | `chad secret set: the seed is not base32` | 1 |
| `set --totp` | Live `mcp.json` names it | `chad secret set: mcp.json names NAME, so it cannot become a TOTP secret` | 1 |
| `rm` | Removed | `Removed NAME` | 0 |
| `rm` | No such name | `chad secret rm: no secret named NAME` | 1 |
| `run` | No such name | `chad secret run: no secret named NAME` | 125 |
| `run` | Bad usage or a bad `--env` pair | `chad secret run: usage: chad secret run [--env VAR=NAME]... [--stdin NAME] -- <command> [args]` or `chad secret run: --env takes VAR=NAME, got <pair>` | 125 |
| `run` | Command not found | `chad secret run: <command>: command not found` | 127 |
| `run` | Command found but not executable | A line on stderr. Its wording is not decided (see Gaps) | 126 |
| `code` | Code printed | The code on stdout. `<n>s left` on stderr, with ` (waited <ms>ms for a new window)` after a wait | 0 |
| `code` | No such name | `chad secret code: no secret named NAME` | 1 |
| `code` | Not a TOTP secret | `chad secret code: NAME is not a TOTP secret` | 1 |
| `request` | Saved while waiting | `Saved NAME` | 0 |
| `request --no-wait` | Button posted | `Asked for NAME` | 0 |
| `request --no-wait` | Repeat | `Already asked for NAME at <HH:MM:SS> UTC` | 0 |
| `request --code` | Code typed | The typed code on stdout | 0 |
| `request` | Stored form timed out | `chad secret request: timed out after 300 s. The button is still there, so NAME can still be saved.` | 1 |
| `request --code` | Timed out | `chad secret request: timed out after 300 s` | 1 |
| `request` | Owner replied in chat | `chad secret request: owner replied in chat instead` | 1 |
| `request` | No owner present, stored form | `chad secret request: asked for NAME, not waiting: no owner is present in this turn` | 1 |
| `request` | No owner present, repeat | `chad secret request: already asked at <HH:MM:SS> UTC` | 1 |
| `request --code` | No owner present | `chad secret request --code: no owner is present in this turn, so nobody can type a code. Nothing was posted.` | 1 |
| `request` | `CHAD_SESSION` unset or `daemon` | `chad secret request: there is no chat thread to ask in here. Save it yourself with: chad secret set NAME` | 2 |
| `request` | The message could not be posted | `chad secret request: the message could not be posted (<reason>)` | 1 |
| `request --code` | A name was given | `chad secret request: --code takes no name, nothing is stored` | 2 |
| `request --code` | Used with `--no-wait` | `chad secret request: --code cannot be used with --no-wait` | 2 |
| `request` | No daemon | `chad secret request: no daemon` | 4 |

- **CRED-109** The texts in this part that chad posts in chat or prints as a CLI error are templates in chad's one `Messages` module, and a unit test checks each template against the wording here (see 17-testing.md).

## The bundled credentials skill

The rules an agent has to follow cannot be enforced by a command, so they live in a skill. A skill is a `SKILL.md` file the agent reads (see 12-skills-and-mcp.md).

- **CRED-83** A bundled skill, `credentials`, ships in the image beside `self-edit` and `diagnose`, which makes three bundled skills. It carries the rules below and one recipe each for agent-browser and Playwright MCP. The secrets section of the `self-edit` skill points at it (see 14-self-edit-skill.md, and 16-failures-logs-status.md for `diagnose`).
- **CRED-84** The skill's first rule is that no recipe prints a stored value. It names the routes that do print one, so the agent avoids them. They are `agent-browser get value` and `agent-browser eval` on a password field, and `chad secret run -- printenv`.
- **CRED-85** The skill says to request a secret only for a site the owner named in that session. This is the answer to a web page that tells the agent to ask for a bank password.
- **CRED-86** The skill shows the quoting trap. `chad secret run --env P=X -- tool "$P"` expands `$P` in the outer shell, where it is empty, so the recipe is `chad secret run --env P=X -- sh -c 'tool "$P"'`.
- **CRED-87** The skill shows how to feed agent-browser's vault with `chad secret run --stdin GITHUB_PASSWORD -- agent-browser auth save github --url <u> --username <name> --password-stdin`.
- **CRED-88** The skill says to call `chad secret request` with clanka's `bash` and `timeoutMs: 330000`, and never with `run`, which moves the command to the background after 2 minutes.
- **CRED-89** The skill says to wait for the next TOTP window before a retry, since many sites reject a code already used. chad has no flag for this. The agent reads the seconds left from `chad secret code`, sleeps past the window and asks again.
- **CRED-90** The skill says to run `agent-browser auth save` again after a secret changes, because the vault and a browser profile keep their own copy and `auth login` sends the old password until then.
- **CRED-91** The skill says to ask for a secret before starting a login, since saving one restarts every MCP server that names it. A call in flight when the secret is saved gets the 30 second drain of an MCP rebuild, and one still running at the end of the drain is interrupted with `mcp.<server>.<tool> was interrupted by an MCP restart. It may have run in part or in full.` (see 12-skills-and-mcp.md).
- **CRED-92** The skill treats browser state as a secret. Cookies, saved state files and agent-browser's vault are never printed, never sent with `sendFile` and never put in the repo. chad itself does nothing with browser state.
- **CRED-93** The skill says where browser state lives. When Playwright MCP launches its own browser, its default profile is under the cache directory, which backups skip, so `--user-data-dir` has to point under `home/`. With a sidecar the profile lives in the sidecar, outside `chad backup`.
- **CRED-94** The skill says that after `agent-browser auth login` prints "Logged in" the agent checks the page's URL or title, and never a field's value. agent-browser prints that line for a login the site refused, because it reports the submit and not the result.
- **CRED-95** The skill says that agent-browser's vault is a second copy of the password, encrypted with a key that sits beside it in `~/.agent-browser/.encryption-key`.
- **CRED-96** The skill carries the rules for a password typed into the chat (CRED-77, CRED-78 and CRED-79) and the plain statement about both factors (CRED-15).
- **CRED-108** The CI checks on a bundled skill, which 14-self-edit-skill.md lists, run on the `credentials` skill too (see 17-testing.md).
- **CRED-127** The skill says to restart the browser service when CDP on `127.0.0.1` refuses a connection after chad's container restarted.

The agent-browser steps that signed in to the prototype's test form, for the recipe. `--cdp 9222` points agent-browser at the sidecar's Chromium.

```sh
chad secret run --stdin SITE_PASSWORD -- agent-browser auth save testsite --url <login url> --username <name> --password-stdin
agent-browser --cdp 9222 auth login testsite
agent-browser --cdp 9222 get url                  # check where the page is, never a field's value
agent-browser --cdp 9222 fill '#code' "$(chad secret code SITE_TOTP 2>/dev/null)"
```

## The browser sidecar

- **CRED-97** The browser sidecar shares chad's network namespace. In compose that is `network_mode: service:chad` on the browser's service. On Kubernetes it is a container in chad's pod.
- **CRED-98** Tools reach the browser's CDP port on loopback, at `http://127.0.0.1:9222` in the recipes. Chrome 149 listens on loopback whatever `--remote-debugging-address` says, and when reached by container name through a forwarder it answers "500 Host header is specified and is not an IP address or localhost."
- **CRED-99** Anything in chad's container can drive the logged-in browser. The spec says so in plain words.
- **CRED-128** The sidecar's service in the Compose example depends on chad's service with `restart: true` (see 01-image-and-volume.md). Compose applies that only to a restart it performs itself, so a chad container that crashes and comes back, or a `docker restart` of it, can still leave the browser unreachable, and CRED-127 is the way out.

## The Playwright MCP recipe

Playwright MCP takes `--secrets <file>`, a dotenv file of names and values. The model passes a secret's name as the text to type, and the server types the value. The recipe builds that file from chad's secret store without leaving a copy on disk.

```json
{
  "mcpServers": {
    "playwright": {
      "command": "bash",
      "args": [
        "-c",
        "exec playwright-mcp --cdp-endpoint http://127.0.0.1:9222 --output-dir /data/cache/playwright-mcp --secrets <(printf \"%s='%s'\\n\" SITE_PASSWORD \"$SITE_PASSWORD\")"
      ],
      "env": {
        "SITE_PASSWORD": "${SITE_PASSWORD}"
      }
    }
  }
}
```

- **CRED-100** The skill's Playwright MCP recipe is the `mcp.json` entry above. chad expands `${SITE_PASSWORD}` into the server's environment, and the `bash -c` wrapper prints it as one dotenv line into a process substitution that `--secrets` reads, so no plaintext file is left on the volume or in `/dev/shm`.
- **CRED-101** The dotenv line uses the single-quoted form `NAME='value'`. In the prototype it carried the three values tried exactly, while the unquoted form cut a value at ` #` and the double-quoted form changed a backslash.
- **CRED-102** With this recipe the value is in the server's `/proc/<pid>/environ`. That is accepted under CRED-12 and CRED-14.
- **CRED-103** The recipe also passes `--output-dir /data/cache/playwright-mcp`, an absolute path under `cache/`, so the page snapshots Playwright MCP writes are not committed to the repo and the recipe does not depend on the server's working directory.
- **CRED-129** The working directory chad gives a stdio MCP server is stated in 12-skills-and-mcp.md.

Playwright MCP masks its own text results by replacing a value with `<secret>NAME</secret>`. Its documentation calls that a convenience and not a security feature, and in the prototype a base64 copy of a value passed it.

## Runs owed to the test plan

- **CRED-104** The build's test plan (see 17-testing.md) includes the seven runs that were asked for and not made. Six are daemon scenarios, and the container one runs in the image layer. They are listed below.
- **CRED-110** The test plan also holds the Enter modal on the test chat platform, a negative test for a click and for a modal submit from someone who is not an owner, the 5 minute wait at its real length in a nightly job, and a real Discord modal completed by hand before a release (see 17-testing.md).

- Retiring a forgotten button on a click (CRED-72).
- The name limit at `request` and `/secret` (CRED-18). Only a button failing to post at a 76 character name was seen.
- The save failing after the modal's reply (CRED-54).
- Recreating chad's container alone on Docker with the shared network namespace, and a restart of chad's container after a crash (CRED-97 and CRED-128).
- `${NAME}` in `mcp.json` naming a TOTP secret failing the apply (CRED-37).
- A dotenv value with a newline, and one with both `'` and ` #` (CRED-101).
- Where an MCP server's working directory is in chad (CRED-103).

These were also never run. A real Discord modal, a real model following the skill, a real site, a derived image with a browser, any of it on Docker (the prototype ran on podman), `chad backup` with browser state, `--note ""`, and the skill as a file.

## Gaps

- **CRED-G1** [tim] Whether Tim's "no redaction" ruling covers the masking of chad's own outputs as well as the `AgentExecutor` wrap. CRED-12 follows the reading that it covers both, which TIM-554 decision 2 leaves for Tim to correct. If he meant only the wrap, masking of stored values of 8 characters or more as `<secret:NAME>` at chad's outputs comes back. Until Tim answers, CRED-12 holds as written and the builder builds no masking.
- **CRED-G4** [builder] What chad replies to the click when it retires a button without opening a modal (CRED-72 and CRED-121). The reply is either the edit itself or a plain acknowledgement followed by the edit, and the owner sees the same edit both ways. CRED-122 is the only fixed part. Closest is TIM-554 decision 7.
- **CRED-G5** [builder] The wording of the message when a save fails after the modal's reply (CRED-54). Closest is TIM-554 decision 5.
- **CRED-G7** [builder] The time zone and format of `<time>` in "already asked at <time>". The prototype prints `HH:MM:SS UTC`. Closest is TIM-546 item 14.
- **CRED-G10** [builder] The wordings in "Command messages" that no rule quotes. They are the prototype's and no ticket decides them. Closest is TIM-554.
- **CRED-G12** [builder] The sidecar's image, how its Chromium is started and the CDP port. The prototype used `mcr.microsoft.com/playwright:v1.61.1-jammy` and port 9222. Closest is TIM-554 decision 4.
- **CRED-G15** [builder] Whether the dotenv line can carry a value with a newline, or with both `'` and ` #`. A newline probably cannot be carried. The daemon scenario of CRED-104 answers it, and the skill then names the values the recipe cannot carry. Closest is TIM-554 decision 12.
- **CRED-G16** [builder] The text of the `credentials` skill. No draft exists. Closest is TIM-546 items 22 and 23.
- **CRED-G17** [tim] Which sites Tim wants chad signed in to on day one. The recipes should be written for those. Closest is TIM-546 "Not settled here".
- **CRED-G18** [builder] Which versions of agent-browser and Playwright MCP the recipes target. The prototype ran agent-browser 0.43.0 and `@playwright/mcp` 0.0.85. Closest is TIM-554.
- **CRED-G19** [builder] The limits a real Discord modal applies. The 45 character title and label and the 100 character id limit are from effect/chat's test adapter, and no real modal was run. The hand check of CRED-110 is the first run on one. Closest is TIM-546 "Not settled here".
- **CRED-G21** [builder] The wording of the line `/secret NAME` answers with when a button for NAME is already in the thread (CRED-125), and of the message `chad secret run` prints with exit 126 (CRED-115). Neither has a wording from the prototype. Closest is the TIM-559 rulings on CRED-G8 and CRED-G11.
- **CRED-G23** [builder] Whether `chad secret set` and `chad secret rm` write `command.ran` when they run with no daemon. CRED-130 has the daemon write the event, and no ticket says whether a CLI with no daemon writes to the log. 10-cli.md holds the same gap for every command that works with no daemon. Closest is TIM-559 round 2 R4.
- **CRED-G24** [builder] The text of the command field in the `command.ran` line of a modal save (CRED-133). The ruling names the command as the secret save and gives no text, and no part fixes the text of that field for any command. Closest is TIM-559 round 4 item 3.
- **CRED-G25** [builder] Whether `command.ran` is written by a `chad secret request` that ends without a save (with `--no-wait`, on a timeout, on an owner reply, on a stop, with no owner present, or in the code form) and by `/secret NAME`. Each posts a button and changes nothing that is stored, and the event is ruled for a command that changes something. CRED-134 covers only a request that returns as saved. Closest is TIM-559 round 4 item 3.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| CRED-1 | TIM-546 item 1, TIM-541 item 4 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| CRED-2 | TIM-546 item 1 | Architect (Tim has not read) | run |  | `definition` | - |
| CRED-3 | TIM-546 item 1 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-4 | TIM-546 comment "From TIM-541" | Architect (Tim has not read) | run |  | `rule` | `image` |
| CRED-5 | TIM-546 item 22 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-6 | TIM-546 item 6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-7 | TIM-542 item 30, amended by TIM-546 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-8 | TIM-554 decision 1 | Tim | run |  | `rule` | `bundled-skills` |
| CRED-9 | TIM-546 item 2, amended by TIM-554 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-10 | TIM-546 item 2 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-11 | TIM-542 item 14, amended by TIM-554 | Tim | not run |  | `rule` | `settings` |
| CRED-12 | TIM-554 decision 2, replacing TIM-546 items 18, 19 and 20 | Tim | not run |  | `rule` | `settings` |
| CRED-13 | TIM-554 "How well each is supported", amended by TIM-558 item 48 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-14 | TIM-546 item 2, TIM-542 item 31, TIM-554 decision 12 | Architect (Tim has not read) | run | TIM-546 | `definition` | - |
| CRED-15 | TIM-546 item 3 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-16 | TIM-546 item 4, TIM-542 item 14 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-17 | TIM-546 items 4 and 5 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-18 | TIM-554 decision 6 | Architect (Tim has not read) | not run | TIM-554 | `rule` | `settings` |
| CRED-19 | TIM-548 item 6 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| CRED-20 | TIM-546 item 5 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-21 | TIM-546 item 4 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-22 | TIM-542 item 14 | Tim | run |  | `rule` | `settings` |
| CRED-23 | TIM-546 item 5 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-24 | TIM-546 item 5, amended by TIM-554 decision 9 | Architect (Tim has not read) | not run | TIM-546, TIM-554 | `rule` | `settings` |
| CRED-25 | TIM-542 items 3 and 14, TIM-546 item 21 | Tim | run |  | `rule` | `skills-mcp` |
| CRED-26 | TIM-546 item 5, TIM-542 item 26 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-27 | TIM-542 item 14 | Tim | run |  | `rule` | `skills-mcp` |
| CRED-28 | TIM-546 item 7 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-29 | TIM-546 item 7 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-30 | TIM-546 item 7 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-31 | TIM-546 item 7 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-32 | TIM-546 item 7 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-33 | TIM-546 item 8 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-34 | TIM-546 item 8, TIM-554 prototype | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-35 | TIM-546 item 8 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-36 | TIM-546 item 8 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-37 | TIM-546 item 8 | Architect (Tim has not read) | not run | TIM-546 | `rule` | `skills-mcp` |
| CRED-38 | TIM-546 item 8 | Architect (Tim has not read) | run | TIM-546 | `rule` | `skills-mcp` |
| CRED-39 | TIM-546 item 9 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-40 | TIM-546 item 10 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-41 | TIM-546 item 9 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-42 | TIM-546 items 9 and 12 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-43 | TIM-546 item 12 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-44 | TIM-546 item 11 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-45 | TIM-546 item 11 | Architect (Tim has not read) | run |  | `definition` | - |
| CRED-46 | TIM-546 item 16 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-47 | TIM-546 items 9 and 14 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-48 | TIM-546 item 9 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-49 | TIM-546 item 9 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-50 | TIM-546 item 17 | Architect (Tim has not read) | read |  | `fact` | `settings` |
| CRED-51 | TIM-554 decision 5 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-52 | TIM-554 decision 5, TIM-554 prototype | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-53 | TIM-546 item 9 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-54 | TIM-554 decision 5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-55 | TIM-554 decision 5 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-56 | TIM-546 item 12 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-57 | TIM-546 item 12 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-58 | TIM-546 item 12 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-59 | TIM-546 item 12 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-60 | TIM-554 decision 8 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-61 | TIM-546 item 12 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-62 | TIM-554 decision 10 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| CRED-63 | TIM-546 item 13 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-64 | TIM-546 item 13 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-65 | TIM-546 item 13 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-66 | TIM-546 item 13, amended by TIM-559 ruling on CLI-G14 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | `settings` |
| CRED-67 | TIM-546 item 14 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-68 | TIM-546 item 14 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-69 | TIM-546 item 14 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-70 | TIM-546 item 14 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-71 | TIM-546 item 14, amended by TIM-554 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-72 | TIM-554 decision 7 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-73 | TIM-546 item 15 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-74 | TIM-546 item 15 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-75 | TIM-546 item 15 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-76 | TIM-546 item 15 | Architect (Tim has not read) | not run | TIM-546 | `rule` | `settings` |
| CRED-77 | TIM-546 item 17 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| CRED-78 | TIM-554 decision 3, replacing part of TIM-546 item 17 | Architect (Tim has not read) | run |  | `rule` | `live` |
| CRED-79 | TIM-546 item 17 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-80 | TIM-546 item 21 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-81 | TIM-546 item 21 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-82 | TIM-546 item 21 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-83 | TIM-546 item 22, TIM-549 "Changed by TIM-554", amended by TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-84 | TIM-554 decision 1 | Tim | run |  | `rule` | `bundled-skills` |
| CRED-85 | TIM-546 item 10 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-86 | TIM-546 item 23 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-87 | TIM-546 item 23 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-88 | TIM-546 item 23 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-89 | TIM-546 item 23, TIM-554 prototype | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-90 | TIM-546 item 23 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-91 | TIM-546 item 23, amended by TIM-555 decision 5 and the TIM-537 follow-up rules 1 and 2 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-92 | TIM-546 item 23 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-93 | TIM-546 item 23 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-94 | TIM-554 decision 11 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-95 | TIM-554 decision 11 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-96 | TIM-546 items 3 and 17, TIM-554 decision 3 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-97 | TIM-554 decision 4 | Architect (Tim has not read) | run |  | `rule` | `image` |
| CRED-98 | TIM-554 decision 4 | Architect (Tim has not read) | run |  | `rule` | `image` |
| CRED-99 | TIM-554 decision 4 | Architect (Tim has not read) | run |  | `definition` | - |
| CRED-100 | TIM-554 decision 12 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-101 | TIM-554 decision 12 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-102 | TIM-554 decision 12 | Architect (Tim has not read) | run |  | `definition` | - |
| CRED-103 | TIM-554 decision 11, amended by TIM-559 ruling on CRED-G14 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-104 | TIM-554 "Not run" and "Passed on", TIM-558 items 52 and 54, amended by TIM-559 ruling on IMG-G17 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-105 | TIM-557 item 4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| CRED-106 | TIM-557 item 39, amended by TIM-559 ruling on SWAP-G13 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-107 | TIM-558 item 35 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-108 | TIM-558 item 32, TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-109 | TIM-558 items 8 and 33 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-110 | TIM-558 items 29, 35, 37 and 52 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| CRED-111 | TIM-559 ruling on SET-G8 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| CRED-112 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| CRED-113 | TIM-559 ruling on CRED-G11 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | `settings` |
| CRED-114 | TIM-559 ruling on CRED-G11 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | `settings` |
| CRED-115 | TIM-559 ruling on CRED-G11 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | `settings` |
| CRED-116 | TIM-559 ruling on SET-G8 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | `settings` |
| CRED-117 | TIM-559 ruling on CRED-G2 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-118 | TIM-559 ruling on DIS-G18 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-119 | TIM-559 ruling on CRED-G6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-120 | TIM-559 ruling on CRED-G6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-121 | TIM-559 ruling on CRED-G3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-122 | TIM-559 ruling on CRED-G4 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-123 | TIM-559 ruling on CRED-G9 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-124 | TIM-559 ruling on CRED-G8 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-125 | TIM-559 ruling on CRED-G8 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-126 | TIM-559 ruling on SES-G3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-127 | TIM-559 ruling on IMG-G17 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-128 | TIM-559 ruling on IMG-G17 | Architect (Tim has not read) | read |  | `rule` | `image` |
| CRED-129 | TIM-559 ruling on CRED-G14 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-130 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-131 | TIM-559 round 3 on CRED-G20 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-132 | TIM-559 round 3 on CRED-G20 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-133 | TIM-559 round 4 item 3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-134 | TIM-559 round 4 item 3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-135 | TIM-559 round 4 item 3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
