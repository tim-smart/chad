# Delivered

This file is the delivered file of 19-build-order.md. The rule-id script (`scripts/rule-ids.ts`) reads it to decide which rules are pending, and reads nothing else for that. It is not a part of the spec and states no rule.

## Slices

The slices that are delivered, in build order. The builder who finishes a slice adds its name here in the change that finishes it.

- `repo`
- `harness`
- `wire`

## Held rules

A rule, or one letter of a rule, whose slice is delivered and whose test cannot pass yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule     | Slice    | Reason                                                                                                                                     |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| MOD-11b  | `models` | The stored override is the file `state/model`, which the `models` slice delivers.                                                          |
| IMG-16b  | `cli`    | The bundled CLI is the file `dist/cli.bundle.js`, which the `cli` slice builds.                                                            |
| SES-4b   | `turns`  | The handler opens a thread for a mention in a channel, which the `turns` slice builds (SES-3).                                             |
| SES-30b  | `kills`  | An event is in flight only when the daemon is killed while it handles it, and the `kills` slice delivers the process driver that kills it. |
| TST-60b  | `kills`  | The scenarios with kills run in layer 4 on the process driver, which the `kills` slice delivers.                                           |
| TST-61c  | `kills`  | The catch-up after a resume or a fresh identify is SES-37, which the `kills` slice builds.                                                 |
| TST-186b | `cli`    | The invite URL is built by `chad connection add discord`, which the `cli` slice delivers.                                                  |

## Stopped rules

A rule that a builder reported as wrong or impossible to build, with one sentence on what is wrong. Tim rules on each one.

| Rule | What is wrong |
| ---- | ------------- |
