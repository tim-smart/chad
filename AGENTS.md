# Building chad

chad is built from the spec in `docs/spec/`. This file is the builder's contract. Read it in full on every run. It says how the build is carried out and nothing about what chad does.

## The spec is the source of truth

- Every behaviour of chad is a rule with a stable id, such as `SES-12`. Build what the rules say.
- Read `docs/spec/00-overview.md`, `docs/spec/17-testing.md` and `docs/spec/19-build-order.md` in full. Read the other parts by rule. Never try to read the whole spec in one run, it does not fit.
- `docs/spec/20-for-tim.md` is for Tim. A builder does not need it.

## The stop rule

- If a rule is wrong or cannot be built, stop work on that rule. Say so on the parent build issue, add it to the delivered file's list of stopped rules with one sentence on what is wrong, build nothing else in its place, and carry on with the rest of the stage.
- A change to an existing rule waits for Tim. Do not reword a rule to match what you built.
- Where the spec is silent, pick the reading that fits the rest of it. If the choice is visible to the owner, a plugin, the model or the CLI, add it to the spec as a new rule in the same change, with the next number of its part's prefix and a Provenance row as `docs/spec/19-build-order.md` describes, and name it in your hand-off comment. A gap tagged `[builder]` is yours to settle the same way.

## Stages, slices and the one branch

- The build is five stages. Each stage is one issue and runs a list of slices in order (`docs/spec/19-build-order.md`). Work one slice at a time.
- All five stages share one branch and one pull request against `main`. Stage 1 creates both. Never open a second pull request, never rebase or force-push the shared branch, and never merge the pull request. Tim merges it after stage 5.
- When you finish a slice, add its name to the delivered file under `docs/spec/` in the same change.
- A rule of a delivered slice whose test cannot pass yet, because it rests on a later slice, goes on the delivered file's list of held rules with that slice's name and a one-sentence reason. That is the only accepted reason.
- A rule that only a live or nightly job can cover goes on the waiver list against that job. Nothing is pending because Tim's bots or logins do not exist yet. A live job that lacks a secret fails and names the secret.
- Scheduled workflows do not fire until the pull request is merged. Give each one a trigger that fires from the shared branch, and run each at least once before your stage is done. A nightly job that is red for any cause but a missing secret holds the stage. The last stage removes these triggers in its final change.
- A stage is done when each of its slices is delivered and every rule of those slices has a test, a waiver, a held entry or a stopped entry. Then move the stage issue to done and post the hand-off comment on the parent build issue: the branch and pull request, what landed, each held and stopped entry you added with its reason, the result of each scheduled job, each live job that has never passed with the number of rules waived against it, and each rule you added to the spec.

## Tests

- Tests are asked for in this repo, whatever your own instructions say about skipping them.
- Every test names the rule ids it covers in its title. The minimum is one test for each rule id, or for each letter where a rule carries letters. No test names no rule id.
- A rule whose kind is `definition` needs no test. A `fact` is tested against the pinned dependency or waived as `docs/spec/17-testing.md` says.
- No `skip`, `todo` or `only`.
- No test and no CI job uses a real Discord token or a real Codex login, apart from the live jobs that `docs/spec/17-testing.md` names.

## Looking a rule up

- Once the rule-id script exists (stage 1, slice `repo`), use its `show <id>` mode for one rule and its list mode for the ids of a slice.
- Before that, search the spec. A rule's text starts with its id in bold, and the last cell of its row in the part's Provenance table is its slice. Only rows under a part's `## Provenance` heading are rule rows:

  ```sh
  rg -F '**SES-12**' docs/spec            # the rule
  rg '^\| SES-12 \|' docs/spec            # its Provenance row
  rg '\| `harness` \|$' docs/spec          # every rule of a slice
  ```

## Code

- Read `node_modules/effect/AGENTS.md` before writing Effect code. It is how Effect is written in the version chad pins. If the installed package does not ship the file, read it from the effect repo at the commit the manifest under `vendor/` names.
- Run every command through the repo's own `flake.nix`: `nix develop -c pnpm install`, and the same for every later command. If you need a new tool, add it to the flake.
- The repo uses oxlint and prettier (`docs/spec/17-testing.md`). The gate runs both, and the type-check is `tsc`.
- Never edit a migration that a delivered slice added. A change to the schema is a new migration.
- The prototypes that ran many of the rules are on the `prototypes` branch, which is never merged. Your stage issue names the ones for your slices. Nothing that stood in for chad carries over into the suite.
