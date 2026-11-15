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

## Held rules

A rule, or one letter of a rule, whose slice is delivered and which cannot be built yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule      | Slice            | Reason                                                                                                                                                                                                   |
| --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SES-96b   | `models`         | chad sends the session id as `prompt_cache_key` and `session-id` only on a Codex login or with `openai` (OV-34), and the `models` slice delivers both; `openai-compat` sends neither.                    |
| FAIL-11   | `discord-ui`     | There is no status message until `discord-ui` delivers it, so no function adds a status line yet; the actions' Info lines are written by `TurnLog.step`, which is where the status line has to be added. |
| SES-69b   | `plugin-api`     | `afterTurn` is a plugin hook, which the `plugin-api` slice delivers.                                                                                                                                     |
| SES-116b  | `models`         | The summarizer override is a setting of the `models` slice.                                                                                                                                              |
| MOD-14b   | `models`         | The summarizer override is a setting of the `models` slice.                                                                                                                                              |
| CLI-138b  | `apply`          | `/safe` arrives with the `apply` slice.                                                                                                                                                                  |
| CLI-138c  | `models`         | `/model` arrives with the `models` slice.                                                                                                                                                                |
| CLI-138d  | `settings`       | The `/secret` forms arrive with the `settings` slice.                                                                                                                                                    |
| CLI-141b  | `apply`          | The route goes through `/safe on`, which the `apply` slice delivers.                                                                                                                                     |
| MOD-11b   | `models`         | The stored override is the file `state/model`, which the `models` slice delivers.                                                                                                                        |
| IMG-85b   | `skills-mcp`     | The cut is made by the stop's 60 second deadline (IMG-82) and its line by the synchronous `stop.cut` write (IMG-139), which the `skills-mcp` slice delivers.                                             |
| IMG-88    | `backup`         | Two of the table's rows rest on later slices: the stop cut by its deadline on `skills-mcp`, and the `state/version` check (IMG-39) on `backup`.                                                          |
| STO-28b   | `backup`         | `chad backup` and `chad restore`, which hold the lock for the whole copy, arrive with the `backup` slice.                                                                                                |
| REC-96b   | `backup`         | The other owner commands arrive with later slices, and the last of them, `restore` and `backup` to stdout, with the `backup` slice.                                                                      |
| CLI-14b   | `apply`          | `chad apply`, which is the command that waits behind the boot, arrives with the `apply` slice.                                                                                                           |
| CLI-20c   | `settings`       | The one call that returns what the owner typed is the one behind `chad secret request --code`, which arrives with the `settings` slice.                                                                  |
| CLI-30b   | `skills-mcp`     | `chad plugin new` and `chad skill new`, which write into `work/` whatever the lock's state, arrive by the `skills-mcp` slice (CLI-156).                                                                  |
| CLI-31b   | `settings`       | `chad setup`, `chad secret` and `chad timezone` arrive with the `settings` slice.                                                                                                                        |
| CLI-31c   | `models`         | `chad login`, `chad logout` and `chad model` arrive with the `models` slice.                                                                                                                             |
| CLI-31d   | `apply`          | `chad safe` arrives with the `apply` slice.                                                                                                                                                              |
| CLI-31e   | `backup`         | `chad backup` and `chad restore` arrive with the `backup` slice.                                                                                                                                         |
| CLI-31g   | `skills-mcp`     | `chad plugin new` and `chad skill new` arrive by the `skills-mcp` slice (CLI-156).                                                                                                                       |
| CLI-31h   | `apply`          | `chad logs` arrives with the `failures` slice and `chad log`, which reads the repo's history, with the `apply` slice.                                                                                    |
| CLI-35b   | `settings`       | The files `state/safe-mode`, `state/model`, `state/timezone`, `secrets/secrets.json` and `secrets/auth/` are written by commands of later slices, the last of them the `settings` slice.                 |
| CLI-37b   | `backup`         | The other changes that go through the queue arrive with later slices, and the last of them, a backup while it copies, with the `backup` slice.                                                           |
| CLI-42b   | `loader`         | The deadline of a plugin's Layer is LOAD-14, which the `loader` slice delivers.                                                                                                                          |
| CLI-42c   | `models`         | The deadline of a model login is MOD-44, which the `models` slice delivers.                                                                                                                              |
| CLI-42d   | `skills-mcp`     | The deadline of an MCP login is MCP-61, which the `skills-mcp` slice delivers.                                                                                                                           |
| CLI-49b   | `settings`       | `chad secret run` and its own usage errors arrive with the `settings` slice.                                                                                                                             |
| CLI-51b   | `settings`       | `chad secret run`, which passes its child's exit code through, arrives with the `settings` slice.                                                                                                        |
| CLI-57b   | `settings`       | `chad setup` arrives with the `settings` slice.                                                                                                                                                          |
| CLI-57c   | `models`         | `chad login`, `chad logout` and `chad model` arrive with the `models` slice.                                                                                                                             |
| CLI-57d   | `backup`         | `chad restore` and `chad backup` to stdout arrive with the `backup` slice.                                                                                                                               |
| CLI-58b   | `backup`         | The commands the list names arrive with later slices, and the last of them, `chad backup <path>`, with the `backup` slice.                                                                               |
| CLI-120b  | `plugin-api`     | Plugins, which read the owner ids as `PluginContext.owners` and are rebuilt on an owner change, arrive with the `plugin-api` slice.                                                                      |
| CLI-125b  | `apply`          | Safe mode arrives with the `apply` slice.                                                                                                                                                                |
| CLI-125c  | `apply`          | The applied commit is the repo's, which the `apply` slice delivers.                                                                                                                                      |
| CLI-125d  | `apply`          | `work/` and its draft arrive with the repo, which the `apply` slice delivers.                                                                                                                            |
| CLI-125e  | `loader`         | Plugins are loaded from the repo, and skipped with a reason, by the `loader` slice.                                                                                                                      |
| CLI-125f  | `skills-mcp`     | MCP servers arrive with the `skills-mcp` slice.                                                                                                                                                          |
| CLI-125g  | `models`         | The stored model and the login state arrive with the `models` slice.                                                                                                                                     |
| CLI-205c  | `settings`       | The Enter modal, which saves a secret, arrives with the `settings` slice.                                                                                                                                |
| FAIL-286b | `apply`          | Safe mode, and why it is on, arrive with the `apply` slice.                                                                                                                                              |
| FAIL-302c | `settings`       | The Enter modal, which saves a secret, arrives with the `settings` slice.                                                                                                                                |
| CLI-46b   | `apply`          | `chad log` arrives with the `apply` slice (CLI-80).                                                                                                                                                      |
| CLI-46d   | `settings`       | `chad secret list` arrives with the `settings` slice (CLI-101).                                                                                                                                          |
| CLI-137b  | `settings`       | `chad.json` and its `"enabled": false` arrive with the `settings` slice (SET-34).                                                                                                                        |
| CLI-137c  | `timers-cron`    | The cron plugin and its tools arrive with the `timers-cron` slice.                                                                                                                                       |
| CLI-137e  | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                            |
| STO-83b   | `bundled-skills` | The `self-edit` skill arrives with the `bundled-skills` slice.                                                                                                                                           |
| STO-133c  | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                            |
| FAIL-108c | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                                            |
| FAIL-63b  | `discord-ui`     | There is no status message until `discord-ui` delivers it, so the give-up message has none to remove.                                                                                                    |
| FAIL-114b | `apply`          | Whether the exit before the daemon's start was unclean comes from the boot counter (IMG-89 to IMG-92), which the `apply` slice delivers.                                                                 |

## Stopped rules

A rule that a builder reported as wrong or impossible to build, with one sentence on what is wrong. Tim rules on each one.

| Rule    | What is wrong                                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRED-77 | It says what the agent does, which only a real model following the `credentials` skill can show, and Tim's fifth ruling of 2026-11-15 withdrew the skill runs, the one check that watched a real model follow a bundled skill.                                                                                                              |
| CRED-78 | As CRED-77, only a real model that is handed a pasted password can show it, and the skill runs are withdrawn.                                                                                                                                                                                                                               |
| IMG-130 | It says when a stop makes IMG-120's attempt to write turn ends, and Tim's fifth ruling of 2026-11-15 took that attempt out of IMG-120 without naming this rule, so there is nothing left for it to time.                                                                                                                                    |
| CLI-161 | A statement of `chad db query` or `chad db check` holds the CLI's one thread until SQLite returns, so no handler can run and SIGTERM ends the command by the signal itself, which a shell reports as 143, and exiting 130 there would take a second process, which STO-80 rules out; every other client command exits 130 for both signals. |
| TST-87  | Review reads it as ending every process a scenario started, and on Linux and macOS alike an unprivileged driver cannot find a background process that leaves its process group, drops the scenario's mark and loses its parent before the driver looks, so the driver ends what it recorded and cannot promise the rest.                    |
| STO-209 | Its second half takes an unfinished turn's prompt as stored when the session's history carries no request key, but a compaction or an earlier turn leaves such a history too, so it can mark a prompt that was never stored and the resume then loses the owner's message.                                                                  |
| STO-210 | Its removal takes the `prompts` row that STO-207 wrote with the prompt of a turn that started before STO-209's migration ran or in the same second, which the volume cannot tell from STO-209's inference, and its last sentence resends such a turn's prompt by a policy Tim has not ruled on.                                             |
