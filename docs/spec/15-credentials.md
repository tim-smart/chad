# Credential tools

This part covers how a tool that has to sign in somewhere gets a stored login. It specifies the `chad secret` commands and the bundled `credentials` skill. It also states what chad does and does not promise about keeping a stored value away from the model. It leans on 10-cli.md for the socket, the exit codes and the `CHAD_SESSION` marker, on 02-storage.md for where the secret file sits, on 11-settings.md and 12-skills-and-mcp.md for `${NAME}` expansion, on 16-failures-logs-status.md for the log, and on 17-testing.md for the tests.

Terms used here. A stored value is the value of a secret in chad's secret store.

## Scope

chad ships the commands that hold logins. It ships nothing that signs in. The owner may add a browser tool on their own, and that tool uses these commands.

- **CRED-1** v1 ships the credential tools and no browser. chad supplies no browser as an MCP server, a skill or a bundled plugin, and the chad image never carries one. chad documents no recipe for a browser tool.
- **CRED-2** The owner may add a browser tool on their own, as an MCP server through `mcp.json` or as a command line tool installed on the volume. chad ships no container for a browser.
- **CRED-3** An image the owner derives from chad's, with a browser added, is the other allowed way to supply a browser.
- **CRED-4** The agent has no sudo and no apt in the container, so a tool that signs in is in the image, installable through npm or uv, or a single binary in `~/.local/bin`.
- **CRED-5** Every credential tool is a `chad` CLI command in the core. The plugin API gains no call for asking the owner or for reading a secret.
- **CRED-6** chad binds no secret to a site or to a session. Every session, sub-agent and background task can use every secret.
- **CRED-7** The agent may run every `chad secret` command.

## What chad promises about stored values

clanka's agent works by writing scripts. A script's source and its console output both enter the session's history, the status message in Discord shows the source, and clanka's built-in handlers print a line such as `Calling "bash"` with the full command into that output. A value that appears in a script or in what a command prints is therefore in Discord, in the database and in the model's context. The credential commands take a secret's name wherever a value would otherwise go.

- **CRED-8** chad's commands and the `credentials` skill's recipes never print a stored value.
- **CRED-9** A stored value used through these commands is not in a script's source, not in an owner message and not in what a chad command prints. The `Calling "bash"` line of such a command shows names only.
- **CRED-10** No chad command prints anything that is derived from a secret's value.
- **CRED-11** There is no `chad secret get`. This rests on chad's commands never printing a stored value, and nothing else stands behind it.
- **CRED-12** chad masks nothing. History rows, the `turns` table including `Failed.reason`, the log, the status message, everything chad posts to chat and the messages an `afterTurn` hook receives are written and sent as they are. There is no `<secret:NAME>` replacement, no wrap of clanka's `AgentExecutor`, and chad does not rewrite rows it has already stored.
- **CRED-13** The test plan holds no test that a value a script printed is absent from chad's outputs. Its one check on stored values tests CRED-8. It stores a canary value, runs every `chad` command and every recipe, and looks for the value in every output and in the log (see 17-testing.md).
- **CRED-105** chad logs each script's source and output, unmasked, to `logs/chad.log` and to the container's stdout. A value a script printed therefore goes wherever the container's logs are shipped (see 16-failures-logs-status.md).
- **CRED-14** chad does not promise a stored value against an agent that goes looking. The agent can read `secrets/secrets.json` with clanka's `readFile`, a browser that has typed a password can be asked for it, `chad secret run -- printenv` prints a value, and a value handed to an MCP server through `mcp.json` is in that server's `/proc/<pid>/environ`. The spec states this in plain words.

One fact from the prototype belongs with CRED-14. clanka saves a command output longer than 30,000 characters to a temporary file and tells the model the path. chad does not write that file. It is mode 644 and outside the data volume, so a value that a script printed into a long output is in it.

## The secret store

A login is not a record of its own. It is plain named secrets, with the site and the username written in a note.

- **CRED-16** Secrets are named entries in `secrets/secrets.json` on the data volume, mode 0600 (see 02-storage.md). A login is plain named secrets in that file.
- **CRED-17** Each entry holds a value, an optional note and the time it was saved.
- **CRED-18** A secret's name matches `[A-Z_][A-Z0-9_]*` and is 64 characters at most. `chad secret set` enforces it.
- **CRED-19** `chad secret set` refuses the name `CHAD_DOLLAR`, which is reserved for writing a literal `${` in configuration (see 11-settings.md).
- **CRED-20** By convention the note holds the site and the username of the login the secret belongs to.

The store as the prototype built it, without the TOTP kind, which v1 does not have.

```ts
export interface Entry {
  readonly value: string
  readonly note?: string | undefined
  /** ISO time of the save. */
  readonly date: string
  // adjusted: TIM-554 decision 2 (the prototype's `typed` field existed only for masking and is gone)
}
/** The content of secrets/secrets.json, keyed by name. */
export type Store = Record<string, Entry>

export const NAME = /^[A-Z_][A-Z0-9_]*$/ // adjusted: TIM-554 decision 6
export const NAME_MAX = 64 // adjusted: TIM-554 decision 6
```

## Commands

```
chad secret set <NAME> [--note <text>]               the value comes from stdin or a hidden prompt
chad secret list [--json]
chad secret rm <NAME>
chad secret run [--env VAR=NAME]... [--stdin NAME] -- <command> [args]
```

The exit codes 0, 1, 2 and 4 mean what 10-cli.md says they mean for every command. `chad secret run` adds 125, 126 and 127 and passes its child's code through.

## Saving, listing and removing

- **CRED-22** `chad secret set <NAME>` takes the value from stdin or from a hidden prompt, and never as an argument.
- **CRED-23** `set` on a name that already exists replaces the value and says so by printing `Replaced NAME` in place of `Saved NAME`.
- **CRED-24** `set` on an existing name keeps the note unless `--note` is given. `--note ""` clears it.
- **CRED-25** With the daemon running, `set` sends the value to the daemon, which saves it through its queue, reloads the plugins whose settings name the secret, rebuilds the MCP layer if `mcp.json` names it, and prints what was reloaded. With no daemon the CLI writes the file itself. The detail is in 10-cli.md and 08-apply-and-swap.md.
- **CRED-26** `chad secret list` prints the name, note and date of each secret, and no value. It takes `--json` (see 10-cli.md).
- **CRED-27** `chad secret rm <NAME>` deletes the secret and reloads what names it, as `set` does.
- **CRED-106** A `chad secret rm` that removed the secret when run from a session posts one subtext line in that session's thread. That includes one that exits 1 because a plugin kept its previous version, and the line then names those plugins (see 08-apply-and-swap.md). Run from the owner's shell it posts nothing, and one that changed nothing posts nothing (see 16-failures-logs-status.md).
- **CRED-111** The reload after a secret is saved or removed leaves out a plugin that is off (see 11-settings.md).
- **CRED-112** The reload after a secret is saved or removed also tries a plugin that a boot skipped, when that plugin's settings name the secret (see 11-settings.md and 09-repo-and-recovery.md).

## Giving a value to a command

`chad secret run` is how a value reaches a tool. It has to be a CLI command and cannot be a clanka tool, because only the process that spawns a child can put a value in that child's environment.

- **CRED-28** `chad secret run --env VAR=NAME [--stdin NAME] -- <command>` runs the command with the value of secret NAME in the environment variable VAR. `--env` can be given more than once.
- **CRED-29** `--stdin NAME` writes the value to the command's stdin with no trailing newline and then closes stdin.
- **CRED-30** For `run` the CLI reads `secrets/secrets.json` itself, whether or not a daemon is running.
- **CRED-31** A name that is not in the store makes `run` exit 125 with `chad secret run: no secret named NAME` on stderr, and the command is not started.
- **CRED-32** Otherwise the command's own exit code is `run`'s exit code. The prototype saw 7 passed through, 143 for a command ended by SIGTERM and 127 for a command that does not exist.
- **CRED-113** Bad usage of `run`, which includes a bad `--env` pair, exits 125 and not the 2 that 10-cli.md gives bad usage in every other command. `run` passes its child's code through, so its own failures use codes a child rarely returns.
- **CRED-114** A command that is not found makes `run` exit 127, which is the code a shell gives for it.
- **CRED-115** A command that is found but is not executable makes `run` exit 126.

## Asking the owner for a secret

v1 has no command that asks the owner for a value and no form in chat that takes one. The owner saves a secret in a shell.

- **CRED-136** The owner saves a secret with `chad secret set NAME` in a shell on the server, and that command is the only way a value gets into the store. When the agent needs a secret that is not stored, it asks the owner in chat to run that command. It never asks for the value itself.

## The Enter button and the modal

- **CRED-46** v1 has one button, Stop, and no modal (see 04-discord.md).

## Waiting, replies and stops

- **CRED-62** chad leaves clanka's `scriptTimeout` limit unset.

## A password typed into the chat

- **CRED-77** The agent never asks for a password as a chat message.
- **CRED-78** If the owner pastes a password anyway, the agent does not save it with `chad secret set`, because the script would carry the value and the status message would post it back. The agent says the value is in the conversation, asks the owner to change the password and save the new one with `chad secret set NAME` in a shell, and suggests deleting the message.
- **CRED-79** Changing the password is the fix for a value that reached the conversation. `/new` only takes the value out of the live context, because the stored rows stay for 30 days after the reset and are in backups.

## What the daemon returns and what it logs

- **CRED-80** No RPC call returns a stored value.
- **CRED-81** `chad secret set` sends a value to the daemon as the payload of its call. Nothing comes back but flags and the names of what was reloaded.
- **CRED-82** The daemon logs no RPC request body, no RPC response body and no interaction payload.
- **CRED-130** When the daemon finishes a `chad secret set` or a `chad secret rm`, it writes the log event `command.ran` (see 16-failures-logs-status.md). The line carries the command, the caller, which is the owner, a session id or the daemon, and the outcome. It never carries a secret's value.

The two calls as the prototype defined them, without what v1 does not have. The RPC group, the socket and the session header belong to 10-cli.md.

```ts
/** A call that ends the command with a non-zero exit and a line on stderr. */
export const Ended = Schema.Struct({ _tag: Schema.Literal("Ended"), exit: Schema.Number, message: Schema.String })

// The one call that carries a value to the daemon. Nothing comes back but flags.
Rpc.make("SecretSet", {
  // note: undefined keeps the stored note, "" clears it // adjusted: TIM-554 decision 9
  payload: { name: Schema.String, value: Schema.String, note: Schema.optional(Schema.String) },
  success: Schema.Struct({ replaced: Schema.Boolean, restarted: Schema.Array(Schema.String) }), // adjusted: TIM-554 decision 2 (no `short` flag)
  error: Ended
})
Rpc.make("SecretRm", { payload: { name: Schema.String }, success: Schema.Boolean, error: Ended })
```

## Command messages

The wordings below are the prototype's. The ones a rule above quotes are decided. The rest were not discussed in a ticket (see Gaps).

| Command | Case | Output | Exit |
| --- | --- | --- | --- |
| `set` | Saved, new name | `Saved NAME`, followed by `, restarted <names>` when something reloaded | 0 |
| `set` | Saved, existing name | `Replaced NAME`, with the same suffix | 0 |
| `set` | Name does not match | `chad secret set: the name must match <pattern>` | 2 |
| `set` | Empty value | `chad secret set: no value on stdin` | 2 |
| `rm` | Removed | `Removed NAME` | 0 |
| `rm` | No such name | `chad secret rm: no secret named NAME` | 1 |
| `run` | No such name | `chad secret run: no secret named NAME` | 125 |
| `run` | Bad usage or a bad `--env` pair | `chad secret run: usage: chad secret run [--env VAR=NAME]... [--stdin NAME] -- <command> [args]` or `chad secret run: --env takes VAR=NAME, got <pair>` | 125 |
| `run` | Command not found | `chad secret run: <command>: command not found` | 127 |
| `run` | Command found but not executable | A line on stderr. Its wording is not decided (see Gaps) | 126 |

- **CRED-109** The texts in this part that chad posts in chat or prints as a CLI error are templates in chad's one `Messages` module, and a unit test checks each template against the wording here (see 17-testing.md).

## The bundled credentials skill

The rules an agent has to follow cannot be enforced by a command, so they live in a skill. A skill is a `SKILL.md` file the agent reads (see 12-skills-and-mcp.md).

- **CRED-83** A bundled skill, `credentials`, ships in the image beside `self-edit` and `diagnose`, which makes three bundled skills. It carries the rules below. The secrets section of the `self-edit` skill points at it (see 14-self-edit-skill.md, and 16-failures-logs-status.md for `diagnose`).
- **CRED-84** The skill's first rule is that no recipe prints a stored value. It names the routes that do print one, so the agent avoids them. They are `chad secret run -- printenv` and a command of a browser tool that reads a password field back.
- **CRED-85** The skill says to ask the owner to save a secret only for a site the owner named in that session. This is the answer to a web page that tells the agent to ask for a bank password.
- **CRED-86** The skill shows the quoting trap. `chad secret run --env P=X -- tool "$P"` expands `$P` in the outer shell, where it is empty, so the recipe is `chad secret run --env P=X -- sh -c 'tool "$P"'`.
- **CRED-91** The skill says to ask for a secret before starting a login, since saving one restarts every MCP server that names it. A call in flight when the secret is saved is interrupted with `mcp.<server>.<tool> was interrupted by an MCP restart. It may have run in part or in full.` (see 12-skills-and-mcp.md).
- **CRED-92** The skill treats the state of a browser tool the owner added as a secret. Cookies, saved state files and a tool's own vault are never printed, never sent with `sendFile` and never put in the repo. chad itself does nothing with browser state.
- **CRED-96** The skill carries the rules for a password typed into the chat (CRED-77, CRED-78 and CRED-79) and the rule for a secret that is not stored (CRED-136).
- **CRED-108** The CI checks on a bundled skill, which 14-self-edit-skill.md lists, run on the `credentials` skill too (see 17-testing.md).

## Runs owed to the test plan

These were never run. A real model following the skill, any of it on Docker (the prototype ran on podman), `--note ""`, and the skill as a file.

## Gaps

- **CRED-G10** [builder] The wordings in "Command messages" that no rule quotes. They are the prototype's and no ticket decides them. Closest is TIM-554.
- **CRED-G16** [builder] The text of the `credentials` skill. No draft exists. Closest is TIM-546 items 22 and 23.
- **CRED-G21** [builder] The wording of the message `chad secret run` prints with exit 126 (CRED-115). It has no wording from the prototype. Closest is the TIM-559 ruling on CRED-G11.
- **CRED-G23** [builder] Whether `chad secret set` and `chad secret rm` write `command.ran` when they run with no daemon. CRED-130 has the daemon write the event, and no ticket says whether a CLI with no daemon writes to the log. 10-cli.md holds the same gap for every command that works with no daemon. Closest is TIM-559 round 2 R4.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| CRED-1 | TIM-546 item 1, TIM-541 item 4, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| CRED-2 | TIM-546 item 1, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run |  | `definition` | - |
| CRED-3 | TIM-546 item 1 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-4 | TIM-546 comment "From TIM-541" | Architect (Tim has not read) | run |  | `rule` | `image` |
| CRED-5 | TIM-546 item 22 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-6 | TIM-546 item 6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-7 | TIM-542 item 30, amended by TIM-546 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-8 | TIM-554 decision 1 | Tim | run |  | `rule` | `bundled-skills` |
| CRED-9 | TIM-546 item 2, amended by TIM-554 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-10 | TIM-546 item 2, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-11 | TIM-542 item 14, amended by TIM-554 | Tim | not run |  | `rule` | `settings` |
| CRED-12 | TIM-554 decision 2, replacing TIM-546 items 18, 19 and 20; answered for Tim by Jarvis, chat 2026-11-15 | Tim; the reading that this covers chad's own outputs kept by Jarvis, delegated by Tim on 2026-11-15 (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-13 | TIM-554 "How well each is supported", amended by TIM-558 item 48 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-14 | TIM-546 item 2, TIM-542 item 31, TIM-554 decision 12 | Architect (Tim has not read) | run | TIM-546 | `definition` | - |
| CRED-16 | TIM-546 item 4, TIM-542 item 14 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-17 | TIM-546 items 4 and 5, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-18 | TIM-554 decision 6, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run | TIM-554 | `rule` | `settings` |
| CRED-19 | TIM-548 item 6 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| CRED-20 | TIM-546 item 5 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-22 | TIM-542 item 14 | Tim | run |  | `rule` | `settings` |
| CRED-23 | TIM-546 item 5, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-24 | TIM-546 item 5, amended by TIM-554 decision 9 | Architect (Tim has not read) | not run | TIM-546, TIM-554 | `rule` | `settings` |
| CRED-25 | TIM-542 items 3 and 14, TIM-546 item 21 | Tim | run |  | `rule` | `skills-mcp` |
| CRED-26 | TIM-546 item 5, TIM-542 item 26, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-27 | TIM-542 item 14 | Tim | run |  | `rule` | `skills-mcp` |
| CRED-28 | TIM-546 item 7 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-29 | TIM-546 item 7 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-30 | TIM-546 item 7, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-31 | TIM-546 item 7 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-32 | TIM-546 item 7 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-46 | TIM-546 item 16, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| CRED-62 | TIM-554 decision 10, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| CRED-77 | TIM-546 item 17, amended by Tim's ruling on the last four stopped rules, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-78 | TIM-554 decision 3, replacing part of TIM-546 item 17, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16, amended by Tim's ruling on the last four stopped rules, chat 2026-11-16 | Architect (Tim has not read) | run |  | `definition` | - |
| CRED-79 | TIM-546 item 17 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRED-80 | TIM-546 item 21, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-81 | TIM-546 item 21 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-82 | TIM-546 item 21, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CRED-83 | TIM-546 item 22, TIM-549 "Changed by TIM-554", amended by TIM-557 item 43, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-84 | TIM-554 decision 1, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Tim | run |  | `rule` | `bundled-skills` |
| CRED-85 | TIM-546 item 10, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-86 | TIM-546 item 23 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-91 | TIM-546 item 23, amended by TIM-555 decision 5 and the TIM-537 follow-up rules 1 and 2, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| CRED-92 | TIM-546 item 23, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-96 | TIM-546 items 3 and 17, TIM-554 decision 3, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-105 | TIM-557 item 4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| CRED-106 | TIM-557 item 39, amended by TIM-559 ruling on SWAP-G13 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-108 | TIM-558 item 32, TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CRED-109 | TIM-558 items 8 and 33 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-111 | TIM-559 ruling on SET-G8 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| CRED-112 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| CRED-113 | TIM-559 ruling on CRED-G11 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | `settings` |
| CRED-114 | TIM-559 ruling on CRED-G11 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | `settings` |
| CRED-115 | TIM-559 ruling on CRED-G11 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | `settings` |
| CRED-130 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CRED-136 | Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `rule` | `settings` |

Retired ids. These rules were withdrawn and removed from this part with their Provenance rows, and the git history of this file holds their text. An id on this list is never used again, and a new rule takes a number above every id in the table and on this list.

CRED-15, CRED-21, CRED-33, CRED-34, CRED-35, CRED-36, CRED-37, CRED-38, CRED-39, CRED-40, CRED-41, CRED-42, CRED-43, CRED-44, CRED-45, CRED-47, CRED-48, CRED-49, CRED-50, CRED-51, CRED-52, CRED-53, CRED-54, CRED-55, CRED-56, CRED-57, CRED-58, CRED-59, CRED-60, CRED-61, CRED-63, CRED-64, CRED-65, CRED-66, CRED-67, CRED-68, CRED-69, CRED-70, CRED-71, CRED-72, CRED-73, CRED-74, CRED-75, CRED-76, CRED-87, CRED-88, CRED-89, CRED-90, CRED-93, CRED-94, CRED-95, CRED-97, CRED-98, CRED-99, CRED-100, CRED-101, CRED-102, CRED-103, CRED-104, CRED-107, CRED-110, CRED-116, CRED-117, CRED-118, CRED-119, CRED-120, CRED-121, CRED-122, CRED-123, CRED-124, CRED-125, CRED-126, CRED-127, CRED-128, CRED-129, CRED-131, CRED-132, CRED-133, CRED-134, CRED-135.
