# Delivered

This file is the delivered file of 19-build-order.md. The rule-id script (`scripts/rule-ids.ts`) reads it to decide which rules are pending, and reads nothing else for that. It is not a part of the spec and states no rule.

## Slices

The slices that are delivered, in build order. The builder who finishes a slice adds its name here in the change that finishes it.

- `repo`
- `harness`
- `wire`

## Held rules

A rule, or one letter of a rule, whose slice is delivered and whose test cannot pass yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule      | Slice            | Reason                                                                                                                                                                                   |
| --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOD-11b   | `models`         | The stored override is the file `state/model`, which the `models` slice delivers.                                                                                                        |
| SES-4b    | `turns`          | The handler opens a thread for a mention in a channel, which the `turns` slice builds (SES-3).                                                                                           |
| SES-30b   | `kills`          | An event is in flight only when the daemon is killed while it handles it, and the `kills` slice delivers the process driver that kills it.                                               |
| TST-60b   | `kills`          | The wire slice runs in layer 4, and its scenarios with kills run there, on the process driver, which the `kills` slice delivers.                                                         |
| TST-61c   | `kills`          | The catch-up after a resume or a fresh identify is SES-37, which the `kills` slice builds.                                                                                               |
| STO-28b   | `backup`         | `chad backup` and `chad restore`, which hold the lock for the whole copy, arrive with the `backup` slice.                                                                                |
| REC-96b   | `backup`         | The other owner commands arrive with later slices, and the last of them, `restore` and `backup` to stdout, with the `backup` slice.                                                      |
| CLI-14b   | `apply`          | `chad apply`, which is the command that waits behind the boot, arrives with the `apply` slice.                                                                                           |
| CLI-20c   | `settings`       | The one call that returns what the owner typed is the one behind `chad secret request --code`, which arrives with the `settings` slice.                                                  |
| CLI-30b   | `skills-mcp`     | `chad plugin new` and `chad skill new`, which write into `work/` whatever the lock's state, arrive by the `skills-mcp` slice (CLI-156).                                                  |
| CLI-31b   | `settings`       | `chad setup`, `chad secret` and `chad timezone` arrive with the `settings` slice.                                                                                                        |
| CLI-31c   | `models`         | `chad login`, `chad logout` and `chad model` arrive with the `models` slice.                                                                                                             |
| CLI-31d   | `apply`          | `chad safe` arrives with the `apply` slice.                                                                                                                                              |
| CLI-31e   | `backup`         | `chad backup` and `chad restore` arrive with the `backup` slice.                                                                                                                         |
| CLI-31g   | `skills-mcp`     | `chad plugin new` and `chad skill new` arrive by the `skills-mcp` slice (CLI-156).                                                                                                       |
| CLI-31h   | `apply`          | `chad logs` arrives with the `failures` slice and `chad log`, which reads the repo's history, with the `apply` slice.                                                                    |
| CLI-35b   | `settings`       | The files `state/safe-mode`, `state/model`, `state/timezone`, `secrets/secrets.json` and `secrets/auth/` are written by commands of later slices, the last of them the `settings` slice. |
| CLI-37b   | `backup`         | The other changes that go through the queue arrive with later slices, and the last of them, a backup while it copies, with the `backup` slice.                                           |
| CLI-42b   | `loader`         | The deadline of a plugin's Layer is LOAD-14, which the `loader` slice delivers.                                                                                                          |
| CLI-42c   | `models`         | The deadline of a model login is MOD-44, which the `models` slice delivers.                                                                                                              |
| CLI-42d   | `skills-mcp`     | The deadline of an MCP login is MCP-61, which the `skills-mcp` slice delivers.                                                                                                           |
| CLI-49b   | `settings`       | `chad secret run` and its own usage errors arrive with the `settings` slice.                                                                                                             |
| CLI-51b   | `settings`       | `chad secret run`, which passes its child's exit code through, arrives with the `settings` slice.                                                                                        |
| CLI-57b   | `settings`       | `chad setup` arrives with the `settings` slice.                                                                                                                                          |
| CLI-57c   | `models`         | `chad login`, `chad logout` and `chad model` arrive with the `models` slice.                                                                                                             |
| CLI-57d   | `backup`         | `chad restore` and `chad backup` to stdout arrive with the `backup` slice.                                                                                                               |
| CLI-58b   | `backup`         | The commands the list names arrive with later slices, and the last of them, `chad backup <path>`, with the `backup` slice.                                                               |
| CLI-120b  | `plugin-api`     | Plugins, which read the owner ids as `PluginContext.owners` and are rebuilt on an owner change, arrive with the `plugin-api` slice.                                                      |
| CLI-125b  | `apply`          | Safe mode arrives with the `apply` slice.                                                                                                                                                |
| CLI-125c  | `apply`          | The applied commit is the repo's, which the `apply` slice delivers.                                                                                                                      |
| CLI-125d  | `apply`          | `work/` and its draft arrive with the repo, which the `apply` slice delivers.                                                                                                            |
| CLI-125e  | `loader`         | Plugins are loaded from the repo, and skipped with a reason, by the `loader` slice.                                                                                                      |
| CLI-125f  | `skills-mcp`     | MCP servers arrive with the `skills-mcp` slice.                                                                                                                                          |
| CLI-125g  | `models`         | The stored model and the login state arrive with the `models` slice.                                                                                                                     |
| CLI-205b  | `turns`          | Chat commands arrive with the `turns` slice.                                                                                                                                             |
| CLI-205c  | `settings`       | The Enter modal, which saves a secret, arrives with the `settings` slice.                                                                                                                |
| FAIL-286b | `apply`          | Safe mode, and why it is on, arrive with the `apply` slice.                                                                                                                              |
| FAIL-302b | `turns`          | Chat commands arrive with the `turns` slice.                                                                                                                                             |
| FAIL-302c | `settings`       | The Enter modal, which saves a secret, arrives with the `settings` slice.                                                                                                                |
| CLI-46b   | `apply`          | `chad log` arrives with the `apply` slice (CLI-80).                                                                                                                                      |
| CLI-46c   | `failures`       | `chad logs` arrives with the `failures` slice.                                                                                                                                           |
| CLI-46d   | `settings`       | `chad secret list` arrives with the `settings` slice (CLI-101).                                                                                                                          |
| CLI-137b  | `settings`       | `chad.json` and its `"enabled": false` arrive with the `settings` slice (SET-34).                                                                                                        |
| CLI-137c  | `timers-cron`    | The cron plugin and its tools arrive with the `timers-cron` slice.                                                                                                                       |
| CLI-137d  | `turns`          | The `turns` table arrives with the `turns` slice (FAIL-99).                                                                                                                              |
| CLI-137e  | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                            |
| STO-83b   | `bundled-skills` | The `self-edit` skill arrives with the `bundled-skills` slice.                                                                                                                           |
| STO-133b  | `turns`          | The `turns` table arrives with the `turns` slice (FAIL-99).                                                                                                                              |
| STO-133c  | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                            |
| FAIL-108b | `turns`          | The `turns` table arrives with the `turns` slice (FAIL-99).                                                                                                                              |
| FAIL-108c | `bundled-skills` | The `diagnose` skill arrives with the `bundled-skills` slice.                                                                                                                            |

## Stopped rules

A rule that a builder reported as wrong or impossible to build, with one sentence on what is wrong. Tim rules on each one.

| Rule | What is wrong |
| ---- | ------------- |
