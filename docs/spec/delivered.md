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
- `skills-mcp`
- `timers-cron`
- `backup`
- `image`
- `bundled-skills`
- `asphodel`

## Held rules

A rule, or one letter of a rule, whose slice is delivered and which cannot be built yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule | Slice | Reason |
| ---- | ----- | ------ |

## Stopped rules

A binding rule (ORD-47) that a builder reported as wrong or impossible to build, with one sentence on what is wrong. Tim rules on each one. An entry on a rule that is a default does not wait for Tim: the open stage settles it and moves it to the simplified rules (ORD-51).

| Rule | What is wrong |
| ---- | ------------- |

## Simplified rules

A default (ORD-48) that was not built as written, with one sentence on what chad does instead. The rule-id script does not read this list. Tim reads it when he reviews the pull request.

| Rule     | What chad does instead                                                                                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FAIL-80  | The line names the cause and the turn's count of retries so far, as "Model error (RateLimitError), retrying (3 so far in this turn)", because clanka gives a part it held back as the agent whose output released it, so a count per call cannot be told apart from the output.                                                                                 |
| FAIL-81  | chad counts the turn's `ErrorRetry` parts from the first one, with no count per agent and no reset on `Usage`, because a held-back `Usage` and `ErrorRetry` come labelled as the releasing agent's.                                                                                                                                                             |
| FAIL-82  | The line carries no 20, because the turn's count is not the count of one model call that `MaxRetries` bounds.                                                                                                                                                                                                                                                   |
| FAIL-250 | The `turn.retry` line's count, `retry`, is the turn's count of retries so far, and the line carries no `of`.                                                                                                                                                                                                                                                    |
| TST-93   | There is no check that every event name is emitted somewhere in layers 3 to 5. Tests are chosen by what chad does (TST-173), and a scenario that passes removes its saved directory, so the check would demand scenarios whose only purpose is to emit a log line.                                                                                              |
| FAIL-328 | A `turn.retry` line carries no `subagent`, a sub-agent's retry's included, because the agent clanka names on a held-back part may not be the one that retried.                                                                                                                                                                                                  |
| SWAP-11  | The sessions row keeps no generation: a live session compares the model settings' generation in memory, and a restart builds the Agent from storage anyway.                                                                                                                                                                                                     |
| SES-84   | The sessions row has no generation column, for the reason given under SWAP-11.                                                                                                                                                                                                                                                                                  |
| SES-168  | The first turn after a restore gets no line naming the background tasks that died, and the model's `listTasks` shows they are gone.                                                                                                                                                                                                                             |
| SES-182  | A `/stop` during the wait for hooks stops the turn once the wait ends, and it ends as `Stopped` all the same.                                                                                                                                                                                                                                                   |
| SES-183  | `/stop` and `/new` sent as a mention in a channel get the reply for a channel with no session.                                                                                                                                                                                                                                                                  |
| API-118  | As SES-183 for `/stop` and `/new` in a channel's session.                                                                                                                                                                                                                                                                                                       |
| DIS-112  | A plugin-started turn that waits on a pending login posts its status message before the wait, as an owner's turn does.                                                                                                                                                                                                                                          |
| DIS-113  | As DIS-112: the status message is already posted when the login completes.                                                                                                                                                                                                                                                                                      |
| DIS-114  | As DIS-112: the owner sees the waiting turn's status message, and no separate waiting notice goes.                                                                                                                                                                                                                                                              |
| MOD-115  | As DIS-112.                                                                                                                                                                                                                                                                                                                                                     |
| MOD-116  | As DIS-114.                                                                                                                                                                                                                                                                                                                                                     |
| FAIL-313 | A one-off notice that could not be delivered is not kept as a held row, so "Problems" does not list it.                                                                                                                                                                                                                                                         |
| SELF-17  | The public API carries doc comments, and no gate step checks them.                                                                                                                                                                                                                                                                                              |
| TST-177  | No step type-checks the spec's signature code blocks: `tsc` checks the `chad` package's declarations, and the type and daemon tests use them.                                                                                                                                                                                                                   |
| SELF-116 | As SELF-17.                                                                                                                                                                                                                                                                                                                                                     |
| TST-88   | No script checks the doc comments, and review does.                                                                                                                                                                                                                                                                                                             |
| API-12   | As SELF-17.                                                                                                                                                                                                                                                                                                                                                     |
| TST-95   | The suite has no scenario for each `Failed.reason` tag; a `LoggedOut` turn has none.                                                                                                                                                                                                                                                                            |
| SWAP-123 | The six messages are functions in `Messages`, and a test refers by name to the ones a scenario reaches (messages 1 and 5). Messages 2, 3, 4 and 6 have no test, since a message's wording gets none.                                                                                                                                                            |
| CLI-122  | Setup turns the intent on only in a run that is given a token, because with the daemon running the CLI never holds the stored one, so a run that keeps the token leaves the intent as it is.                                                                                                                                                                    |
| CLI-184  | With nothing stored, the no-argument form reports the `TZ` of the CLI's own environment, which is the daemon's in the one container chad runs in.                                                                                                                                                                                                               |
| TST-33   | `runDaemon` also takes the bundled skills directory of TST-217.                                                                                                                                                                                                                                                                                                 |
| TST-203  | `runDaemon` also takes the bundled skills directory of TST-217.                                                                                                                                                                                                                                                                                                 |
| LOAD-46  | The daemon reads skills from the exported tree that `live` points at, by its own path, and hands out a skill's path through `repo/live` (LOAD-87).                                                                                                                                                                                                              |
| MCP-36   | chad decodes the snapshot's `mcp.json` itself, as MCP-141 says, in place of calling clanka's `McpConfig.load`.                                                                                                                                                                                                                                                  |
| MCP-17   | For a name that differs from its directory, and for a missing name, the error says to set `name: "<dir>"` quoted, so the line it suggests also works for a name YAML would read as a number or a boolean.                                                                                                                                                       |
| CLI-74   | As MCP-36.                                                                                                                                                                                                                                                                                                                                                      |
| REC-45   | chad catches the error of its own decoder of `mcp.json` (MCP-141), in place of `McpConfig.load`'s.                                                                                                                                                                                                                                                              |
| CRON-111 | Cron names a job's timer `<name>#<id>`, with the job id of CRON-149, so that a run's outcome reaches only the job that asked for it. The label of the job's turns is still its name.                                                                                                                                                                            |
| TST-94   | No check records which `Messages` names the scenarios expect; a scenario refers by name to the messages it reaches, and the rest have no test, since a message's wording gets none.                                                                                                                                                                             |
| TST-106  | No migration fixture is saved, because no release has shipped. The seeded scenario makes its tar in the test, from a volume with a session, its history and a pending cron job, and no held timer.                                                                                                                                                              |
| TST-107  | With no released fixture, the seeded tar is restored and booted as a volume an older chad left, which takes the copy, then resumes the old session and fires the timer. Its schema is not rolled back, because the newest migration is the timers table the timer lives in; a separate scenario rolls that migration back and kills the copy and the migration. |
| ASP-102  | Each scenario is mapped to its test, or to the reason it has none, in the header of `test/daemon/asphodel.test.ts`, since 17-testing.md has no such table (TST-153).                                                                                                                                                                                            |
