# Delivered

This file is the delivered file of 19-build-order.md. The rule-id script (`scripts/rule-ids.ts`) reads it to decide which rules are pending, and reads nothing else for that. It is not a part of the spec and states no rule.

## Slices

The slices that are delivered, in build order. The builder who finishes a slice adds its name here in the change that finishes it.

- `repo`
- `harness`
- `wire`

## Held rules

A rule, or one letter of a rule, whose slice is delivered and whose test cannot pass yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule      | Slice        | Reason                                                                                                                                     |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| MOD-11b   | `models`     | The stored override is the file `state/model`, which the `models` slice delivers.                                                          |
| SES-4b    | `turns`      | The handler opens a thread for a mention in a channel, which the `turns` slice builds (SES-3).                                             |
| SES-30b   | `kills`      | An event is in flight only when the daemon is killed while it handles it, and the `kills` slice delivers the process driver that kills it. |
| TST-60b   | `kills`      | The wire slice runs in layer 4, and its scenarios with kills run there, on the process driver, which the `kills` slice delivers.           |
| TST-61c   | `kills`      | The catch-up after a resume or a fresh identify is SES-37, which the `kills` slice builds.                                                 |
| TST-186b  | `cli`        | The invite URL is built by `chad connection add discord`, which the `cli` slice delivers.                                                  |
| CLI-14b   | `apply`      | `chad apply`, which is the command that waits behind the boot, arrives with the `apply` slice.                                             |
| CLI-20b   | `settings`   | The stored secrets, and the one call that returns what the owner typed, arrive with the `settings` slice.                                  |
| CLI-42b   | `loader`     | The deadline of a plugin's Layer is LOAD-14, which the `loader` slice delivers.                                                            |
| CLI-42c   | `models`     | The deadline of a model login is MOD-44, which the `models` slice delivers.                                                                |
| CLI-42d   | `skills-mcp` | The deadline of an MCP login is MCP-61, which the `skills-mcp` slice delivers.                                                             |
| CLI-49b   | `settings`   | `chad secret run` and its own usage errors arrive with the `settings` slice.                                                               |
| CLI-51b   | `settings`   | `chad secret run`, which passes its child's exit code through, arrives with the `settings` slice.                                          |
| CLI-125b  | `apply`      | Safe mode arrives with the `apply` slice.                                                                                                  |
| CLI-125c  | `apply`      | The applied commit is the repo's, which the `apply` slice delivers.                                                                        |
| CLI-125d  | `apply`      | `work/` and its draft arrive with the repo, which the `apply` slice delivers.                                                              |
| CLI-125e  | `loader`     | Plugins are loaded from the repo, and skipped with a reason, by the `loader` slice.                                                        |
| CLI-125f  | `skills-mcp` | MCP servers arrive with the `skills-mcp` slice.                                                                                            |
| CLI-125g  | `models`     | The stored model and the login state arrive with the `models` slice.                                                                       |
| FAIL-286b | `apply`      | Safe mode, and why it is on, arrive with the `apply` slice.                                                                                |

## Stopped rules

A rule that a builder reported as wrong or impossible to build, with one sentence on what is wrong. Tim rules on each one.

| Rule | What is wrong |
| ---- | ------------- |
