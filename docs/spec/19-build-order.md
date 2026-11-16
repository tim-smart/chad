# Build order

This part gives the order in which chad is built: the five stages, the slices each stage runs, why the slices come in this order, the point from which Tim can run chad on his own server, how the build starts, and what the `AGENTS.md` at the root of the repo tells a builder. It leans on 17-testing.md for the rule ids, the pending rules and how tests are chosen, and on 00-overview.md for the pins. Nothing in this part has been run. Its rules describe how the build is carried out and none of them is chad's behaviour, so each is a definition and has no test, apart from the rules about the delivered file, which the rule-id script reads.

## Stages

A stage is one build issue. A slice is a named piece of the build, and every rule's row in its part's Provenance table names the slice in which the rule is built.

| Stage | Slices, in build order | Ends with |
| --- | --- | --- |
| 1 | `repo`, `harness`, `wire`, `cli` | A repo that builds and tests an image, one message in and a scripted answer out, and a CLI that reaches the daemon. |
| 2 | `turns`, `kills`, `failures`, `discord-ui`, `models` | The first usable build: an owner talks to chad in Discord on a real model. |
| 3 | `plugin-api`, `loader`, `apply` | chad loads plugins from its repo and applies a change to itself. |
| 4 | `settings`, `skills-mcp`, `timers-cron` | Settings, secrets, skills, MCP servers and cron. |
| 5 | `backup`, `image`, `bundled-skills`, `asphodel`, `live` | Everything a release needs. |

- **ORD-1** chad is built in five stages, in the order of the table above. A stage starts only when the stage before it is done.
- **ORD-2** All five stages share one branch and one pull request against `main`. Stage 1 creates the branch and opens the pull request, and every later stage commits to the same branch. Nobody opens a second pull request, and nobody rebases or force-pushes the shared branch.
- **ORD-3** No stage merges the pull request. Tim merges it after stage 5.
- **ORD-4** Within a stage the slices are built in the order of the table, one slice at a time. A stage holds more rules than one run of a builder can read, so a stage is expected to take several runs.
- **ORD-5** No limit is set on how many rule ids a stage or a slice holds (see 17-testing.md).
- **ORD-6** A stage is done when its slices are implemented, reviewed on the shared branch and in the delivered file of ORD-9, and every rule of those slices is built, held or stopped. Review is what says a rule is built (see 17-testing.md).
- **ORD-7** When a stage is done its builder moves the stage issue to done and posts a hand-off comment on the parent build issue. The comment gives the branch and the pull request, what the stage delivered, each held entry the stage added with its reason, each rule it added to the spec, each live job that has never passed, and the time of `pnpm test` and of the image layer on the stage's last gate run.
- **ORD-8** The pull request's description holds a review guide, which each stage extends with what it added.
## The delivered file

Every slice lands on one branch, so the rule-id script cannot tell from a merge which slices are delivered. A file in the repo tells it.

- **ORD-9** A file under `docs/spec/` lists the slices that are delivered, in build order. The builder who finishes a slice adds the slice's name to the file in the change that finishes it. The file's name and format are the builder's.
- **ORD-10** The rule-id script treats a rule as pending while its slice is not in the delivered file, and reads nothing else to decide it.
- **ORD-11** The delivered file also holds the list of held rules. A held rule is a rule, or one letter of a rule, whose slice is delivered and which cannot be built yet because it rests on a later slice. Each entry gives the rule id or the id with its letter, the later slice that will deliver it, and the reason in one sentence.
- **ORD-12** The rule-id script treats a held rule as pending until the slice its entry names is in the delivered file. From then on the script fails while the entry is still there.
- **ORD-40** The rule-id script fails on a slice name in the delivered file that the build order does not have, and on a held entry whose named slice is unknown or is the rule's own slice, so that a mistyped name cannot hold a rule for good.
- **ORD-41** The rule-id script cannot judge a reason. The reviewer of a stage reads every held entry the stage added, from the stage's hand-off comment, and the stage is not done while the reviewer rejects one.
- **ORD-42** The delivered file holds a third list, the stopped rules. A stopped rule is one a builder reported under the stop rule of ORD-28. Its entry gives the rule id and one sentence that says what is wrong with the rule. The rule-id script treats a stopped rule as pending and prints the list. The script fails on a stopped entry whose id is unknown or withdrawn, or whose rule also has a held entry.
- **ORD-43** A stage can be done while it has stopped rules, and its hand-off comment lists them. The build is not done while any rule is stopped: Tim, or whoever he names to change the spec during the build, rules on each one, the rule is changed or withdrawn in the spec, and the stage that is open at the time builds what was ruled. If no stage is open at the time, the last stage is reopened to build it.
- **ORD-44** No job reads a secret. No rule is pending because something Tim has to provide does not exist yet (see 17-testing.md).
- **ORD-13** "Too hard", "flaky" and "Tim has not read it" are not reasons for a held rule. The only reason is that the rule rests on something a later slice delivers.
- **ORD-14** A rule's row in its Provenance table keeps one slice. A builder who finds that a whole rule sits in a slice before a slice it rests on changes the rule's slice in the same change, and names the rule in the hand-off comment. A builder who finds that one statement of a rule rests on a later slice gives the rule letters (see 17-testing.md) and holds that letter.
## Slices

| Slice | Stage | What it delivers |
| --- | --- | --- |
| `repo` | 1 | The package, the lockfile and `vendor/`, the flake, the CI skeleton, the rule-id script and the delivered file. Rules about the repo's layout, the toolchain and the dependency pins. |
| `harness` | 1 | `runDaemon`, which takes its connections and their owner ids as an input until `cli` stores them (see 17-testing.md), the scenario driver, the fake model server's `openai-compat` side, the local platform and its adapter, the thinnest storage open and migrate, the `Session` entity and one turn (a message in, a scripted answer out, on the `openai-compat` model that `CHAD_MODEL` names), the owner allowlist and the own-message drop, the logger core and the event-name type, the real Dockerfile with `chad serve` and its `HEALTHCHECK` line (the `chad health` command that line calls arrives in `cli`, so the container reports unhealthy until then), and the cluster shard-count row and its guard. No job reads a secret, and no job talks to a real Discord. |
| `wire` | 1 | The Discord wire slice: the real gateway hook and a dfx shard over a scripted socket. Rules about the Discord gateway, intents and what the adapter does on the wire. |
| `cli` | 1 | The socket, the lock and the CLI skeleton: RPC, the queue, `health`, `status`, `db query`, the version header, the session marker, exit codes, and connection and owner storage with `chad connection` and `chad owner`. The stored connections replace the connections input of `runDaemon`, a connection or owner change reaches the running daemon with no restart, and the first turn inside the image runs here. |
| `turns` | 2 | Sessions and turns in one process: steering, `/new`, `/stop`, chat commands, the stored history and the reconcile, passivation, compaction, the `turns` table, attachments into the inbox. |
| `kills` | 2 | The process-scenario driver and everything that needs a kill or a restart: the resumed turn, the give-up, the graceful stop with its 15 second wait for requests in flight, redelivery, and the catch-up after a restart. |
| `failures` | 2 | The full logger, `chad logs`, `Failed.reason` and the failed-turn messages, the notice table and notices, the free space check, the status blocks. |
| `discord-ui` | 2 | What a turn looks like in Discord: the status message, the split, attachments out, the Stop button, the wordings. |
| `models` | 2 | The providers, the Codex login on the fake's Codex side, `/model`, the model check, the usage limit, the retry line and the silence bound. |
| `plugin-api` | 3 | The plugin API with plugins handed to `runDaemon` through its plugins input (see 17-testing.md): the four modules, hooks and their ordering, prompt chunks, the key-value store, `Turns` and plugin-started turns, `sendFile`, tools, the Agent rebuild by generation. No loading from the repo. |
| `loader` | 3 | The type layer with the six mistakes, check and bundle, loading plugins from an exported tree. |
| `apply` | 3 | The repo, `chad apply`, the swap, revert, recovery and safe mode. |
| `settings` | 4 | `chad.json`, settings, secrets, the timezone, the persona, `chad setup`, and the credential tools (`chad secret set`, `list`, `rm` and `run`). |
| `skills-mcp` | 4 | Skills, MCP servers, and the stop's 60 second deadline, which only an MCP server can hold a stop open long enough to reach. |
| `timers-cron` | 4 | Timers and the cron plugin. |
| `backup` | 5 | `chad backup` and `chad restore`, the prune job, the before-migration copy. |
| `image` | 5 | The Kubernetes manifests and the script of their checks. |
| `bundled-skills` | 5 | The `self-edit`, `credentials` and `diagnose` skills, the skill text and its checks. |
| `asphodel` | 5 | The check that all twelve asphodel scenarios are green. Each scenario's own rules go in the earliest slice that can run it. |
| `live` | 5 | The rest of the live layer: the Codex list, and one checklist for it and for the hand checks. |

- **ORD-15** A slice's rules are the rules whose Provenance row names the slice. The table above says what each slice is for and is not a list of its rules. Where the table and a rule's row disagree, the row holds.
## Why the slices come in this order

- **ORD-16** `harness` comes before every slice that has behaviour to test, so that each later slice starts with a driver, a fake model and a local platform. It delivers the owner allowlist and the drop of chad's own messages, so that both hold before anything that can run `bash` answers a real gateway (see 17-testing.md).
- **ORD-17** `wire` comes straight after `harness`. The gateway parts of the Discord adapter have never been run, and the slice finds out whether they hold before the slices that build on them (see 17-testing.md).
- **ORD-18** Withdrawn.
- **ORD-46** There is no scheduled workflow and no release list.
- **ORD-19** `plugin-api` comes after `models`, so that stage 2 ends at a build an owner can use. Every rule that needs a plugin-started turn, a hook, a prompt chunk, `sendFile`, a plugin's log line or the Agent rebuild by generation is tagged `plugin-api` or a later slice.
- **ORD-20** `plugin-api` comes before `loader`. The API is built and tested with plugins handed to `runDaemon` through its plugins input, each one a name and a `Plugin.make` value (see 17-testing.md), and loading a plugin from the repo is added on top of an API that already works.
- **ORD-21** `backup`, `image`, `bundled-skills`, `asphodel` and `live` come last, because each of them checks or packages what the earlier slices built.
## The first usable build

- **ORD-22** The first usable build is the end of stage 2, after the `models` slice. From there Tim can run the image on his own server.
- **ORD-23** At the first usable build an owner can add a Discord connection and an owner with the CLI, log in to Codex, and talk to chad in a thread. Turns, steering, `/new`, `/stop`, `/model`, the status message, the failed-turn messages, notices, `chad status` and `chad logs` work, and a turn survives a restart.
- **ORD-24** The first usable build has no plugins, no apply, no `chad.json`, no secrets, no skills, no MCP servers, no timers, no cron, no backup and no `chad setup`. It is set up with `chad connection` and `chad owner`, and it runs from the Dockerfile alone, since the Kubernetes manifests arrive in `image`. A connection or an owner that is changed while the daemon runs takes effect at once with no restart, because the swap of a running connection's gateway arrives with `cli` (see 10-cli.md).
- **ORD-25** The rule that a changed model reaches a session that is already open at the start of its next turn is delivered with `plugin-api`, because it rests on the rebuild of the Agent by generation. At the first usable build that rule has no test yet, and a changed model is only sure to reach a session opened after the change (see 05-model-and-login.md and 08-apply-and-swap.md).
## How the build starts

- **ORD-26** The spec is published as the first pull request of the chad repo, `tim-smart/chad`, under `docs/spec/`, with the `AGENTS.md` of ORD-32 and no workflow. `main` holds only a README until Tim merges that pull request.
- **ORD-27** Tim merging the spec's pull request is the go for the build. No stage starts before it.
- **ORD-28** After the merge a change to a binding rule (ORD-47) waits for Tim. A builder who finds a binding rule wrong or impossible to build stops work on that rule, says so on the parent build issue, builds nothing else in its place, and carries on with the rest of the stage.
- **ORD-47** A rule binds when Tim agreed it, when it decides who chad obeys or what chad keeps secret, when breaking it loses or damages what is on the volume, or when it says what a kill, a crash, a restart or two things happening at once must not lose or do twice. Tim agreed a rule when the Agreed by cell of its Provenance row names him without "Tim has not read", and where the cell gives Tim one clause and somebody else another, only Tim's clause binds. In a rule that binds for one of the other three reasons the outcome binds, and a number, a deadline, a wording, an order of steps or a mechanism in it is a default unless the outcome depends on it.
- **ORD-48** Every other rule is a default, which describes one way that works. A builder builds it as written when that is also the simplest way. When something simpler gives the owner, a plugin, the model and the CLI the same outcome, or the rule covers a case that one owner on one server will not meet, the builder builds the simpler thing or leaves the case out, without stopping and without waiting for Tim.
- **ORD-49** The delivered file holds a fourth list, the simplified rules. Each entry gives the id of a default that was not built as written and one sentence on what chad does instead. The rule is not reworded. The rule-id script does not read the list, a simplified rule counts as built, and Tim reads the list when he reviews the pull request.
- **ORD-50** A withdrawn rule is not built. A rule that still names a withdrawn rule, or a feature that 00-overview.md lists as cut from v1 (OV-57), holds as far as it makes sense without it, and a builder does not stop over the reference.
- **ORD-51** A stopped entry on a rule that is a default under ORD-47 no longer waits for Tim. The stage that is open settles it as ORD-48 says and moves the entry to the simplified rules, or removes the entry when the rule is built as written.
- **ORD-29** Where the spec is silent, the builder picks the reading that fits the rest of it. If the choice is visible to the owner, a plugin, the model or the CLI, the builder adds it to the spec as a new rule in the same change, and names it in the hand-off comment. The new rule takes the next number after the highest id of its part's prefix. Its Provenance row has the Source "Build, stage" with the stage's number, the Agreed by "Builder (Tim has not read)", the Support "run", and the slice that is being built. A gap tagged for the builder is settled the same way and does not wait for Tim.
- **ORD-30** If effect/chat ships in a release of effect before stage 1 starts, chad installs the released packages and the repo has no `vendor/` directory (see 00-overview.md).
- **ORD-31** The prototype archives are on a branch of the chad repo named `prototypes`, which is never merged. Each stage issue names the archives that ran the rules of its slices (see 17-testing.md).
## The builder's contract

A builder reads `AGENTS.md` at the root of the repo on every run and may not read the parent build issue, so the file repeats what every stage has to follow.

- **ORD-32** `AGENTS.md` at the root of the chad repo holds the builder's contract and nothing about chad's behaviour. It is short enough to read in full on every run.
- **ORD-33** `AGENTS.md` states which rules bind and which are defaults (ORD-47 and ORD-48), the list of simplified rules (ORD-49), what a withdrawn rule means (ORD-50) and the stop rule of ORD-28: a binding rule that is wrong or cannot be built is reported and left, and nothing else is built in its place.
- **ORD-34** `AGENTS.md` says that a test names the rule ids it covers in its title, where it covers any, that tests are chosen by what chad does and only three kinds of rule need a test of their own, and that the instruction to skip tests in a builder's own brief does not apply to this repo (see 17-testing.md).
- **ORD-35** `AGENTS.md` says how to look a rule up: the rule-id script's `show <id>` mode prints one rule, and its list mode prints the ids of one slice. It tells the builder to read 00-overview.md and 17-testing.md in full and the other parts by rule, never the whole spec in one run.
- **ORD-36** `AGENTS.md` gives the path of effect's own `AGENTS.md` inside the installed package and tells the builder to read it before writing Effect code.
- **ORD-37** `AGENTS.md` says that a migration which a delivered slice added is never edited, and that a change to the schema is a new migration (see 02-storage.md).
- **ORD-38** `AGENTS.md` states the rules of the shared branch from ORD-2 and ORD-3, and that every command runs through the repo's own `flake.nix`.
- **ORD-39** `AGENTS.md` says that no test and no CI job uses a real Discord token or a real Codex login, apart from the live jobs that 17-testing.md names.
## Gaps

- **ORD-G1** [builder] The name and format of the delivered file, and whether the rule-id script's list mode takes a slice or a stage, are not given.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| ORD-1 | TIM-559 round 2 R6; Tim, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| ORD-2 | Tim, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| ORD-3 | Tim, chat 2026-11-15; answered for Tim by Jarvis, chat 2026-11-15 | Tim; one merge kept over a merge after each stage by Jarvis, delegated by Tim on 2026-11-15 (Tim has not read) | not run |  | `definition` | - |
| ORD-4 | Tim, chat 2026-11-15; TIM-559 round 2 R10 item 2 | Tim for the stages. Architect (Tim has not read) for one slice at a time | not run |  | `definition` | - |
| ORD-5 | Tim, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| ORD-6 | TIM-559 round 2 R7; Tim, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Tim for the stage. Architect (Tim has not read) for the rest | not run |  | `definition` | - |
| ORD-7 | Tim, chat 2026-11-15, TIM-559 round 5 item 2, amended by Tim's ruling that `pnpm test` has a target of one minute, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| ORD-8 | Tim, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| ORD-9 | TIM-559 round 4 item 11; follows from Tim, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-10 | TIM-559 round 4 item 11; follows from Tim, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-11 | TIM-559 round 4 item 11; follows from Tim, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-12 | TIM-559 round 4 item 11; follows from Tim, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-13 | TIM-558 item 3 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-14 | TIM-559 round 2 R2 and R6 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-15 | TIM-559 round 2 R6 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-16 | TIM-558 items 13 and 50; TIM-559 round 2 R6 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-17 | TIM-558 items 26 and 27 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-18 | TIM-559 round 2 R6 item 5, withdrawn by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-19 | Tim, chat 2026-11-15; TIM-559 round 2 R10 item 4 | Tim for the order. Architect (Tim has not read) for the first usable mark | not run |  | `definition` | - |
| ORD-20 | TIM-559 round 2 R6; TIM-559 cold read | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-21 | TIM-559 round 2 R6 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-22 | TIM-559 round 2 R10 item 4; Tim, chat 2026-11-15, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Tim for stage 2. Architect (Tim has not read) for the mark | not run |  | `definition` | - |
| ORD-23 | Tim, chat 2026-11-15; the slice tags of the parts | Jarvis, assembling the spec (Tim has not read) | not run |  | `definition` | - |
| ORD-24 | Tim, chat 2026-11-15; the slice tags of the parts; TIM-559 cold read, amended by Tim's ruling that chad has no Compose example, chat 2026-11-15 | Jarvis, assembling the spec (Tim has not read) | not run |  | `definition` | - |
| ORD-25 | The slice tags of MOD-18 and SWAP-8 | Jarvis, assembling the spec (Tim has not read) | not run |  | `definition` | - |
| ORD-26 | TIM-559 round 2 R1; Tim, chat 2026-11-15 | Architect (Tim has not read). Tim created the repo himself and made it public | not run |  | `definition` | - |
| ORD-27 | TIM-559 round 2 R1 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-28 | TIM-559 round 2 R7 and R10 item 1, amended by Tim's ruling that most rules are defaults, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-29 | TIM-559 round 2 R7, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-30 | TIM-559 ruling on OV-G2 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-31 | TIM-559 round 2 R10 item 6 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-32 | TIM-559 round 2 R10 item 1 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-33 | TIM-559 round 2 R10 item 1, amended by Tim's ruling that most rules are defaults, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-34 | TIM-559 round 2 R10 item 1; TIM-558 item 3, amended by Tim's ruling that a rule another rule's test runs needs no test of its own, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-35 | TIM-559 round 2 R10 items 1 and 2 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-36 | TIM-559 round 2 R10 item 1 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-37 | TIM-559 round 2 R10 item 1; Tim, chat 2026-11-15 | Architect (Tim has not read). Tim for a delivered slice in place of a merged pull request | not run |  | `definition` | - |
| ORD-38 | Tim, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| ORD-39 | TIM-558 items 1 and 36 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-40 | TIM-559 round 4 item 11, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-41 | TIM-559 round 4 item 11 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-42 | TIM-559 cold read, wire reader; TIM-559 round 2 R7; TIM-559 round 5 item 1, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-43 | TIM-559 cold read, wire reader; TIM-559 round 2 R7; TIM-559 round 5 item 1 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-44 | TIM-559 cold read, wire reader; TIM-558 item 3; TIM-559 round 5 item 2, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-46 | TIM-559 cold read, wire reader; follows from Tim, chat 2026-11-15; TIM-559 round 5 item 3, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| ORD-47 | Tim's ruling that most rules are defaults, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `definition` | - |
| ORD-48 | Tim's ruling that most rules are defaults, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `definition` | - |
| ORD-49 | Tim's ruling that most rules are defaults, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `definition` | - |
| ORD-50 | Tim's ruling that most rules are defaults, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `definition` | - |
| ORD-51 | Tim's ruling that most rules are defaults, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `definition` | - |
