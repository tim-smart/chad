# Waivers

This file is the waiver list of 17-testing.md. The rule-id script (`scripts/rule-ids.ts`) reads it. It is not a part of the spec and states no rule.

A rule that only a nightly or a live item can cover names that item, which is a vitest project that the pull request gate does not run, and a test in that project names the rule's id. A fact names, in place of an item, the rule whose test would fail if the fact stopped holding.

## Waivers

| Rule     | Covered by |
| -------- | ---------- |
| DIS-3    | `discord`  |
| DIS-89   | `discord`  |
| SES-8    | `discord`  |
| TST-186a | `discord`  |
