# Delivered

This file is the delivered file of 19-build-order.md. The rule-id script (`scripts/rule-ids.ts`) reads it to decide which rules are pending, and reads nothing else for that. It is not a part of the spec and states no rule.

## Slices

The slices that are delivered, in build order. The builder who finishes a slice adds its name here in the change that finishes it.

- `repo`
- `harness`

## Held rules

A rule, or one letter of a rule, whose slice is delivered and whose test cannot pass yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule    | Slice    | Reason                                                                            |
| ------- | -------- | --------------------------------------------------------------------------------- |
| MOD-11b | `models` | The stored override is the file `state/model`, which the `models` slice delivers. |

## Stopped rules

A rule that a builder reported as wrong or impossible to build, with one sentence on what is wrong. Tim rules on each one.

| Rule | What is wrong |
| ---- | ------------- |
