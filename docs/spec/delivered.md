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

## Held rules

A rule, or one letter of a rule, whose slice is delivered and which cannot be built yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule      | Slice            | Reason                                                                                                                                                                                                            |
| --------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI-138b  | `apply`          | `/safe` arrives with the `apply` slice.                                                                                                                                                                           |
| CLI-141b  | `apply`          | The route goes through `/safe on`, which the `apply` slice delivers.                                                                                                                                              |
| IMG-85b   | `skills-mcp`     | The cut is made by the stop's 60 second deadline (IMG-82) and its line by the synchronous `stop.cut` write (IMG-139), which the `skills-mcp` slice delivers.                                                      |
| IMG-88    | `backup`         | Two of the table's rows rest on later slices: the stop cut by its deadline on `skills-mcp`, and the `state/version` check (IMG-39) on `backup`.                                                                   |
| STO-28b   | `backup`         | `chad backup` and `chad restore`, which hold the lock for the whole copy, arrive with the `backup` slice.                                                                                                         |
| REC-96b   | `backup`         | The other owner commands arrive with later slices, and the last of them, `restore` and `backup` to stdout, with the `backup` slice.                                                                               |
| CLI-14b   | `apply`          | `chad apply`, which is the command that waits behind the boot, arrives with the `apply` slice.                                                                                                                    |
| CLI-30b   | `skills-mcp`     | `chad plugin new` and `chad skill new`, which write into `work/` whatever the lock's state, arrive by the `skills-mcp` slice (CLI-156).                                                                           |
| CLI-31b   | `settings`       | `chad setup`, `chad secret` and `chad timezone` arrive with the `settings` slice.                                                                                                                                 |
| CLI-31d   | `apply`          | `chad safe` arrives with the `apply` slice.                                                                                                                                                                       |
| CLI-31e   | `backup`         | `chad backup` and `chad restore` arrive with the `backup` slice.                                                                                                                                                  |
| CLI-31g   | `skills-mcp`     | `chad plugin new` and `chad skill new` arrive by the `skills-mcp` slice (CLI-156).                                                                                                                                |
| CLI-31h   | `apply`          | `chad logs` arrives with the `failures` slice and `chad log`, which reads the repo's history, with the `apply` slice.                                                                                             |
| CLI-35b   | `settings`       | The files `state/safe-mode`, `state/model`, `state/timezone`, `secrets/secrets.json` and `secrets/auth/` are written by commands of later slices, the last of them the `settings` slice.                          |
| CLI-37b   | `backup`         | The other changes that go through the queue arrive with later slices, and the last of them, a backup while it copies, with the `backup` slice.                                                                    |
| CLI-49b   | `settings`       | `chad secret run` and its own usage errors arrive with the `settings` slice.                                                                                                                                      |
| CLI-51b   | `settings`       | `chad secret run`, which passes its child's exit code through, arrives with the `settings` slice.                                                                                                                 |
| CLI-57b   | `settings`       | `chad setup` arrives with the `settings` slice.                                                                                                                                                                   |
| CLI-57d   | `backup`         | `chad restore` and `chad backup` to stdout arrive with the `backup` slice.                                                                                                                                        |
| CLI-58b   | `backup`         | The commands the list names arrive with later slices, and the last of them, `chad backup <path>`, with the `backup` slice.                                                                                        |
| CLI-120b  | `apply`          | Plugins read the owner ids as `PluginContext.owners` at load, and rebuilding them on an owner change goes through the swap, which the `apply` slice delivers.                                                     |
| CLI-125b  | `apply`          | Safe mode arrives with the `apply` slice.                                                                                                                                                                         |
| CLI-125c  | `apply`          | The applied commit is the repo's, which the `apply` slice delivers.                                                                                                                                               |
| CLI-125d  | `apply`          | `work/` and its draft arrive with the repo, which the `apply` slice delivers.                                                                                                                                     |
| CLI-125f  | `skills-mcp`     | MCP servers arrive with the `skills-mcp` slice.                                                                                                                                                                   |
| FAIL-286b | `apply`          | Safe mode, and why it is on, arrive with the `apply` slice.                                                                                                                                                       |
| CLI-46b   | `apply`          | `chad log` arrives with the `apply` slice (CLI-80).                                                                                                                                                               |
| CLI-46d   | `settings`       | `chad secret list` arrives with the `settings` slice (CLI-101).                                                                                                                                                   |
| CLI-137b  | `settings`       | `chad.json` and its `"enabled": false` arrive with the `settings` slice (SET-34).                                                                                                                                 |
| CLI-137c  | `timers-cron`    | The cron plugin and its tools arrive with the `timers-cron` slice.                                                                                                                                                |
| CLI-137e  | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                                     |
| STO-83b   | `bundled-skills` | The `self-edit` skill arrives with the `bundled-skills` slice.                                                                                                                                                    |
| STO-133c  | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                                     |
| FAIL-108c | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                                     |
| STO-110   | `backup`         | The prune job whose runs leave the request and reply arrives with the `backup` slice.                                                                                                                             |
| SES-15    | `timers-cron`    | Plugin turns run through the persisted `plugin` request, and the turns a timer starts arrive with timers, which the `timers-cron` slice delivers.                                                                 |
| SES-53    | `timers-cron`    | `[SILENT]` and the owner mention are built, and the turns `Turns.schedule` starts arrive with the `timers-cron` slice.                                                                                            |
| CRON-43   | `timers-cron`    | The mention is built for every plugin turn, and the turns `Turns.schedule` starts arrive with the `timers-cron` slice.                                                                                            |
| API-3     | `apply`          | A plugin loads in a scope of its own and unloads at the stop, and unloading and loading it again in a running daemon is the swap, which the `apply` slice delivers.                                               |
| API-14    | `settings`       | `DateTime.CurrentTimeZone` is the host's zone until the owner's timezone arrives with the `settings` slice.                                                                                                       |
| API-68    | `apply`          | A background fiber runs in its plugin's scope, and a previous version's scope exists only once a swap does, which the `apply` slice delivers.                                                                     |
| LOAD-15   | `settings`       | The owner ids reach a plugin at load, and its timezone is the host's zone until the `settings` slice brings the owner's.                                                                                          |
| LOAD-64   | `skills-mcp`     | Plugins stop after the sessions at the stop, the swap's part of the order arrives with the `apply` slice, and the MCP servers' part with the `skills-mcp` slice.                                                  |
| SWAP-34   | `apply`          | A chunk change reaches the next turn's update message, and the reload case needs the swap, which the `apply` slice delivers.                                                                                      |
| FAIL-262  | `apply`          | `hook.dropped` is logged for hooks a stop drops, and the swap, removal, turning off and safe mode cases arrive with the `apply` slice.                                                                            |
| ASP-12    | `settings`       | The fixture reads chad's timezone, which is the host's zone until the owner's timezone arrives with the `settings` slice.                                                                                         |
| TST-39    | `apply`          | The Codex subset runs on the fake's Codex side, and its Agent rebuild that keeps the session's model layer is a plugin swap's, which the `apply` slice delivers.                                                  |
| LOAD-14   | `apply`          | A boot skips a plugin whose Layer misses the deadline, and the apply that the deadline fails arrives with the `apply` slice.                                                                                      |
| LOAD-20   | `bundled-skills` | Every package of the image resolves for a plugin, and the `self-edit` skill that says which ones are promised arrives with the `bundled-skills` slice.                                                            |
| LOAD-23   | `apply`          | The check gives the rewritten error, and `chad check` and `chad apply`, which fail on it, arrive with the `apply` slice.                                                                                          |
| LOAD-25   | `apply`          | The type-check of an exported tree is built, and `chad check` and `chad apply`, which run it, arrive with the `apply` slice.                                                                                      |
| LOAD-53   | `apply`          | The names, `tsc`, each bundle and the `Plugin.isPlugin` test run in this order, and the Layer builds of the changed plugins and the trial `Agent.makeWith` belong to the apply, which the `apply` slice delivers. |
| LOAD-72   | `apply`          | The check gives the error that names both files, and `chad check` and `chad apply` arrive with the `apply` slice.                                                                                                 |
| LOAD-92   | `apply`          | The check gives the error for the name, and `chad check` and `chad apply` arrive with the `apply` slice.                                                                                                          |
| REC-25    | `apply`          | The type-check and the `Plugin.isPlugin` test are built, and the apply, which builds the Layers and runs the trial `Agent.makeWith`, arrives with the `apply` slice.                                              |
| TST-202   | `apply`          | A plugin handed to `runDaemon` builds through the same scope and the same deadline as a repo plugin, and the swap code it shares with them arrives with the `apply` slice.                                        |

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
