# Delivered

This file is the delivered file of 19-build-order.md. The rule-id script (`scripts/rule-ids.ts`) reads it to decide which rules are pending, and reads nothing else for that. It is not a part of the spec and states no rule.

## Slices

The slices that are delivered, in build order. The builder who finishes a slice adds its name here in the change that finishes it.

- `repo`

## Held rules

A rule, or one letter of a rule, whose slice is delivered and whose test cannot pass yet because it rests on a later slice. The entry goes when that slice is delivered.

| Rule    | Slice     | Reason                                                                                              |
| ------- | --------- | --------------------------------------------------------------------------------------------------- |
| TST-5a  | `harness` | The Dockerfile that names the Node version arrives with the `harness` slice.                        |
| IMG-56b | `harness` | The image build that repeats the count is the Dockerfile's, which arrives with the `harness` slice. |

## Stopped rules

A rule that a builder reported as wrong or impossible to build, with one sentence on what is wrong. Tim rules on each one.

| Rule | What is wrong |
| ---- | ------------- |
