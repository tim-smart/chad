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
- A rule of a delivered slice that cannot be built yet, because it rests on a later slice, goes on the delivered file's list of held rules with that slice's name and a one-sentence reason. That is the only accepted reason.
- Nothing is pending because Tim's bot or logins do not exist yet. No job reads a secret, and no job talks to a real Discord.
- There is no scheduled workflow and no release list, and `gate.yml` is the only workflow. Every test runs on the gate, apart from the live checks that are done by hand.
- A stage is done when each of its slices is delivered and every rule of those slices is built, held or stopped. Review is what says a rule is built. Then move the stage issue to done and post the hand-off comment on the parent build issue: the branch and pull request, what landed, each held and stopped entry you added with its reason, each live job that has never passed, each rule you added to the spec, and the time of `pnpm test` and of the image layer on the stage's last gate run.

## Tests

- Tests are asked for in this repo, whatever your own instructions say about skipping them.
- Tests are chosen by what chad does, not by rule id (TST-173 in `docs/spec/17-testing.md`). A slice has scenarios that run each of its features the way the owner, a plugin, the model or the CLI reaches it, and one scenario passes through many rules. As a guide, a feature gets its main path and the one or two failures that would hurt most.
- A rule needs a test that fails when the rule is broken only if (a) it decides who chad obeys or what chad keeps secret, (b) breaking it loses or damages what is on the volume, or (c) it says what happens on a kill, a crash, a race, a lock or a timeout. A bug that review or the owner finds gets a regression test with its fix. No other rule needs a test, and no number of tests is set.
- Nothing gets a test of its own for the wording of a message or a log line, a default, what `tsc` already holds, or a fact about a dependency. No test is added only to carry a rule id.
- A test names the rule ids it covers in its title, where it covers any.
- A test that only pins something the last two bullets say needs no test may be deleted, in place of fixing it, when your change breaks it. Say so in the commit message.
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
- Code under `src/` reads and writes files through Effect's `FileSystem` service, never through `node:fs`. A failed call is then a `PlatformError` in the error channel, and `src/Errno.ts` gives its errno code. The exceptions are the log file's appender, because a `Logger` writes synchronously, `src/Version.ts`, which reads at module load, the `existsSync` in front of a `node:sqlite` open, and a call `FileSystem` does not have, such as `statfs`. Tests and `scripts/` may use `node:fs`.
- Run every command through the repo's own `flake.nix`: `nix develop -c pnpm install`, and the same for every later command. If you need a new tool, add it to the flake.
- The repo uses oxlint and prettier (`docs/spec/17-testing.md`). The gate runs both, and the type-check is `tsc`.
- Never edit a migration that a delivered slice added. A change to the schema is a new migration.
- The prototypes that ran many of the rules are on the `prototypes` branch, which is never merged. Your stage issue names the ones for your slices. Nothing that stood in for chad carries over into the suite.
