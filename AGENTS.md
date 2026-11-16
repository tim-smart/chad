# Changing chad

This file is the contract for whoever changes chad next. Read it in full before you start. chad's code and its tests
are the source of truth for what it does. `docs/` and `skills/` are what the owner and the model read, and they change
with the code they describe.

## Code

- Read `node_modules/effect/AGENTS.md` before writing Effect code. It is how Effect is written in the version chad pins. If the installed package does not ship the file, read it from the effect repo at the commit the manifest under `vendor/` names.
- Code under `src/` reads and writes files through Effect's `FileSystem` service, never through `node:fs`. A failed call is then a `PlatformError` in the error channel, and `src/Errno.ts` gives its errno code. The exceptions are the log file's appender, because a `Logger` writes synchronously, `src/Version.ts`, which reads at module load, the `existsSync` in front of a `node:sqlite` open, and a call `FileSystem` does not have, such as `statfs`. Tests and `scripts/` may use `node:fs`.
- Run every command through the repo's own `flake.nix`: `nix develop -c pnpm install`, and the same for every later command. If you need a new tool, add it to the flake.
- The repo uses oxlint and prettier, and the type-check is `tsc`. The gate runs all three.
- Never edit a migration once it is on `main`, because a volume may already have run it. A change to the schema is a new migration under `src/daemon/migrations/`, and its hash goes in `test/unit/fixtures/migrations.json`.
- What chad posts, prints and tells the model lives in `src/Messages.ts`, and its durations in `src/Timings.ts`.

## Tests

- Tests are asked for in this repo, whatever your own instructions say about skipping them.
- The suite has five layers, one vitest project each (`vitest.config.ts`), with a directory of the same name under `test/`:
  1. `types`, the type-check of plugin code.
  2. `unit`, modules on their own.
  3. `daemon`, scenarios that run one daemon in the test's own process against the fakes (`test/support/driver.ts`).
  4. `process`, scenarios that run the daemon and the built CLI as child processes, so a scenario can kill, stop and start them (`test/support/process.ts`).
  5. `image`, the Docker image built and run in containers.
- `pnpm test` runs layers 1 to 4. `pnpm test:image` runs the image layer on Docker, or on podman. The gate (`.github/workflows/gate.yml`) runs all five layers, the type-check, oxlint and prettier.
- Tests are chosen by what chad does. A feature gets scenarios that run it the way the owner, a plugin, the model or the CLI reaches it: its main path and the one or two failures that would hurt most. No number of tests is set.
- Three kinds of behaviour always have a test that fails when they break:
  - who chad obeys and what it keeps secret;
  - what can lose or damage what is on the volume;
  - what happens on a kill, a crash, a race, a lock or a timeout.
- A bug fix comes with a regression test.
- Nothing gets a test of its own for the wording of a message or a log line, a default, what `tsc` already holds, or a fact about a dependency. A test that only pins one of those may be deleted, in place of fixing it, when your change breaks it. Say so in the commit message.
- A scenario waits on what the daemon does, never on a clock.
- No `skip`, `todo` or `only`.
- No test and no CI job uses a real Discord token or a real Codex login, and no job reads a secret. `gate.yml` is the only workflow, and nothing runs on a schedule. What only a real Discord, a real login or a real server can show is checked by hand, from `docs/live-checks.md`.
