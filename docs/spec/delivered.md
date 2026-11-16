# Delivered

This file is the delivered file of 19-build-order.md. The rule-id script (`scripts/rule-ids.ts`) reads it to decide which rules are pending, and reads nothing else for that. A rule of a delivered slice that is neither held nor stopped is built, and review is what says so. It is not a part of the spec and states no rule.

## Slices

The slices that are delivered, in build order. The builder who finishes a slice adds its name here in the change that finishes it.

- `repo`
- `harness`
- `wire`
- `cli`
- `turns`
- `kills`
- `failures`
- `discord-ui`
- `models`
- `plugin-api`
- `loader`
- `apply`
- `settings`

## Held rules

A rule, or one letter of a rule, whose slice is delivered and which cannot be built yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule      | Slice            | Reason                                                                                                                                                                                          |
| --------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMG-85b   | `skills-mcp`     | The cut is made by the stop's 60 second deadline (IMG-82) and its line by the synchronous `stop.cut` write (IMG-139), which the `skills-mcp` slice delivers.                                    |
| IMG-88    | `backup`         | Two of the table's rows rest on later slices: the stop cut by its deadline on `skills-mcp`, and the `state/version` check (IMG-39) on `backup`.                                                 |
| STO-28b   | `backup`         | `chad backup` and `chad restore`, which hold the lock for the whole copy, arrive with the `backup` slice.                                                                                       |
| REC-96b   | `backup`         | The other owner commands arrive with later slices, and the last of them, `restore` and `backup` to stdout, with the `backup` slice.                                                             |
| CLI-31e   | `backup`         | `chad backup` and `chad restore` arrive with the `backup` slice.                                                                                                                                |
| CLI-37b   | `backup`         | The other changes that go through the queue arrive with later slices, and the last of them, a backup while it copies, with the `backup` slice.                                                  |
| CLI-57d   | `backup`         | `chad restore` and `chad backup` to stdout arrive with the `backup` slice.                                                                                                                      |
| CLI-58b   | `backup`         | The commands the list names arrive with later slices, and the last of them, `chad backup <path>`, with the `backup` slice.                                                                      |
| CLI-125f  | `skills-mcp`     | MCP servers arrive with the `skills-mcp` slice.                                                                                                                                                 |
| CLI-102b  | `skills-mcp`     | The MCP layer that a secret change rebuilds arrives with the `skills-mcp` slice.                                                                                                                |
| CLI-97b   | `bundled-skills` | The `credentials` skill arrives with the `bundled-skills` slice.                                                                                                                                |
| CRED-136b | `bundled-skills` | What the agent asks the owner is taught by the `credentials` skill, which arrives with the `bundled-skills` slice (CRED-96).                                                                    |
| CLI-137c  | `timers-cron`    | The cron plugin and its tools arrive with the `timers-cron` slice.                                                                                                                              |
| CLI-137e  | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                   |
| STO-83b   | `bundled-skills` | The `self-edit` skill arrives with the `bundled-skills` slice.                                                                                                                                  |
| STO-133c  | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                   |
| FAIL-108c | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                   |
| STO-110   | `backup`         | The prune job whose runs leave the request and reply arrives with the `backup` slice.                                                                                                           |
| SES-15    | `timers-cron`    | Plugin turns run through the persisted `plugin` request, and the turns a timer starts arrive with timers, which the `timers-cron` slice delivers.                                               |
| SES-53    | `timers-cron`    | `[SILENT]` and the owner mention are built, and the turns `Turns.schedule` starts arrive with the `timers-cron` slice.                                                                          |
| CRON-43   | `timers-cron`    | The mention is built for every plugin turn, and the turns `Turns.schedule` starts arrive with the `timers-cron` slice.                                                                          |
| LOAD-64   | `skills-mcp`     | Plugins stop after the sessions at the stop, the swap's part of the order arrives with the `apply` slice, and the MCP servers' part with the `skills-mcp` slice.                                |
| LOAD-20   | `bundled-skills` | Every package of the image resolves for a plugin, and the `self-edit` skill that says which ones are promised arrives with the `bundled-skills` slice.                                          |
| CLI-32    | `skills-mcp`     | `apply`, `check`, `revert`, `plugin reload` and `plugin purge` exit 4 with no daemon now. `mcp restart` arrives with `skills-mcp`.                                                              |
| CLI-67    | `skills-mcp`     | Every check that rests on no later slice is built, a malformed skill included. A malformed `mcp.json` arrives with the MCP layer of `skills-mcp`.                                               |
| CLI-70    | `skills-mcp`     | Each MCP server's change, status and tool count arrive with the MCP layer of `skills-mcp`. The commit, the plugin and skill lines and the closing line are built.                               |
| CLI-71    | `timers-cron`    | The count of overdue held timers arrives with `timers-cron`. The settings keys, the wait, the interrupted calls and the affected sessions with their sub-agents and background tasks are built. |
| LOAD-52   | `timers-cron`    | A new plugin loads, and a deleted one or one turned off with `"enabled": false` unloads with its data kept. The plugin's timers arrive with `timers-cron`.                                      |
| REC-11    | `skills-mcp`     | Plugins, `chad.json`, the persona and skills load only from an exported tree. `mcp.json` arrives with the MCP layer of `skills-mcp`.                                                            |
| REC-59    | `timers-cron`    | `chad safe on` is a swap to nothing that drops queued hooks and refuses calls. Holding the plugins' timers arrives with `timers-cron`.                                                          |
| SWAP-109  | `skills-mcp`     | The plugins' scopes close in the stop's last step now. The MCP layer and the stop's 60 second deadline arrive with `skills-mcp`.                                                                |
| MCP-145   | `bundled-skills` | The image copies `skills/` to `/opt/chad/skills` once the `bundled-skills` slice adds the first bundled skill, and until then no bundled skill exists.                                          |
| ASP-7     | `asphodel`       | The asphodel plugin arrives with the `asphodel` slice. A plugin's settings under `plugins.<name>.settings` in `chad.json` are built.                                                            |
| ASP-9     | `asphodel`       | The asphodel plugin and its bearer token arrive with the `asphodel` slice. The expansion of `${NAME}` from the secret store or process env is built.                                            |

## Stopped rules

A binding rule (ORD-47) that a builder reported as wrong or impossible to build, with one sentence on what is wrong. Tim rules on each one. An entry on a rule that is a default does not wait for Tim: the open stage settles it and moves it to the simplified rules (ORD-51).

| Rule | What is wrong |
| ---- | ------------- |

## Simplified rules

A default (ORD-48) that was not built as written, with one sentence on what chad does instead. The rule-id script does not read this list. Tim reads it when he reviews the pull request.

| Rule     | What chad does instead                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FAIL-80  | The line names the cause and the turn's count of retries so far, as "Model error (RateLimitError), retrying (3 so far in this turn)", because clanka gives a part it held back as the agent whose output released it, so a count per call cannot be told apart from the output. |
| FAIL-81  | chad counts the turn's `ErrorRetry` parts from the first one, with no count per agent and no reset on `Usage`, because a held-back `Usage` and `ErrorRetry` come labelled as the releasing agent's.                                                                             |
| FAIL-82  | The line carries no 20, because the turn's count is not the count of one model call that `MaxRetries` bounds.                                                                                                                                                                   |
| FAIL-250 | The `turn.retry` line's count, `retry`, is the turn's count of retries so far, and the line carries no `of`.                                                                                                                                                                    |
| FAIL-328 | A `turn.retry` line carries no `subagent`, a sub-agent's retry's included, because the agent clanka names on a held-back part may not be the one that retried.                                                                                                                  |
| SWAP-11  | The sessions row keeps no generation: a live session compares the model settings' generation in memory, and a restart builds the Agent from storage anyway.                                                                                                                     |
| SES-84   | The sessions row has no generation column, for the reason given under SWAP-11.                                                                                                                                                                                                  |
| SES-168  | The first turn after a restore gets no line naming the background tasks that died, and the model's `listTasks` shows they are gone.                                                                                                                                             |
| SES-182  | A `/stop` during the wait for hooks stops the turn once the wait ends, and it ends as `Stopped` all the same.                                                                                                                                                                   |
| SES-183  | `/stop` and `/new` sent as a mention in a channel get the reply for a channel with no session.                                                                                                                                                                                  |
| API-118  | As SES-183 for `/stop` and `/new` in a channel's session.                                                                                                                                                                                                                       |
| DIS-112  | A plugin-started turn that waits on a pending login posts its status message before the wait, as an owner's turn does.                                                                                                                                                          |
| DIS-113  | As DIS-112: the status message is already posted when the login completes.                                                                                                                                                                                                      |
| DIS-114  | As DIS-112: the owner sees the waiting turn's status message, and no separate waiting notice goes.                                                                                                                                                                              |
| MOD-115  | As DIS-112.                                                                                                                                                                                                                                                                     |
| MOD-116  | As DIS-114.                                                                                                                                                                                                                                                                     |
| FAIL-313 | A one-off notice that could not be delivered is not kept as a held row, so "Problems" does not list it.                                                                                                                                                                         |
| SELF-17  | The public API carries doc comments, and no gate step checks them.                                                                                                                                                                                                              |
| TST-177  | No step type-checks the spec's signature code blocks: `tsc` checks the `chad` package's declarations, and the type and daemon tests use them.                                                                                                                                   |
| SELF-116 | As SELF-17.                                                                                                                                                                                                                                                                     |
| TST-88   | No script checks the doc comments, and review does.                                                                                                                                                                                                                             |
| API-12   | As SELF-17.                                                                                                                                                                                                                                                                     |
| TST-95   | The suite has no scenario for each `Failed.reason` tag; a `LoggedOut` turn has none.                                                                                                                                                                                            |
| SWAP-123 | The six messages are functions in `Messages`, and a test refers by name to the ones a scenario reaches (messages 1 and 5). Messages 2, 3, 4 and 6 have no test, since a message's wording gets none.                                                                            |
| CLI-122  | Setup turns the intent on only in a run that is given a token, because with the daemon running the CLI never holds the stored one, so a run that keeps the token leaves the intent as it is.                                                                                    |
| CLI-184  | With nothing stored, the no-argument form reports the `TZ` of the CLI's own environment, which is the daemon's in the one container chad runs in.                                                                                                                               |
| TST-33   | `runDaemon` also takes the bundled skills directory of TST-217.                                                                                                                                                                                                                 |
| TST-203  | `runDaemon` also takes the bundled skills directory of TST-217.                                                                                                                                                                                                                 |
| LOAD-46  | The daemon reads skills from the exported tree that `live` points at, by its own path, and hands out a skill's path through `repo/live` (LOAD-87).                                                                                                                              |
