# Waivers

This file is the waiver list of 17-testing.md. The rule-id script (`scripts/rule-ids.ts`) reads it. It is not a part of the spec and states no rule.

A rule that only a live item can cover names that item, which is a vitest project that the pull request gate does not run, and a test in that project names the rule's id. The hand checks are no project. A rule or a fact that only they can cover names TST-144, the rule that lists them, and the text of that rule names the id. Any other fact names, in place of an item, the rule whose test would fail if the fact stopped holding.

A rule that another rule's test already runs may name that rule in place of an item, in the form a fact uses: the covered rule on the left and the rule whose test runs it on the right. Either side may be one letter of a rule. The named rule is another rule and never a second letter of the same one. It has a test of its own on the gate, for the letter the line names or for each of its letters when the line names none, so a rule waived this way cannot be named by another. The script counts these rules under the reason "another rule's test". A rule that decides who chad obeys, or what chad keeps secret, is never waived this way. The script cannot tell such a rule from any other, nor whether the named test really runs the rule, so reviews judge both.

## Waivers

| Rule   | Covered by |
| ------ | ---------- |
| DIS-3  | TST-144    |
| DIS-4  | TST-144    |
| DIS-89 | TST-144    |
| SES-8  | TST-144    |
