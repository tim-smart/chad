# The `apply` slice: the builder's record

This is the builder's record of how the `apply` slice was delivered, kept in the repository so that review can read it. It is not spec. Where it and `docs/spec/` differ, the spec is right and this file is wrong. A test file is named where a test whose title names the id runs it.

It accounts for every id that `node scripts/rule-ids.ts list apply` prints, which is 320 ids: the 318 of the spec as it stood and the two builder rules this slice added, SWAP-154 and REC-154.

## Summary

Counts by status:

- built: 282 (2 of them the new builder rules)
- built, part held: 25
- held: 12
- simplified: 1
- stopped: 0

No row is NOT BUILT. A "built, part held" row is built except for the clause `docs/spec/delivered.md` holds, and the row names the slice it waits on. A "held" row has nothing built yet.

Held, as `docs/spec/delivered.md` lists them:

- `settings`: everything that rests on `chad.json`, a secret, the timezone or `chad plugin purge`. That is API-23, API-65, CLI-88, CLI-150, CLI-158, DIS-83, FAIL-238, LOAD-50, LOAD-51, LOAD-63, LOAD-88, REC-108, SELF-126, SWAP-39, SWAP-41 and SWAP-121.
- `skills-mcp`: skills, `mcp.json`, `mcp restart`, the stop's 60 second deadline and `chad plugin new` (CLI-84). That is CLI-32, CLI-67, CLI-68, CLI-70, CLI-86, CLI-87, REC-11, SET-54, SWAP-109, and SELF-32, SELF-33, SELF-47 to SELF-52 and SELF-110.
- `timers-cron`: the timers that a plugin turned off or unloaded keeps. That is CLI-71, LOAD-52 and REC-59.

Where a rule rests on two later slices, the entry names the later one, so it stays held until both have landed.

Simplified: SWAP-123. The six messages are functions in `Messages`, and the tests refer by name to the two a scenario reaches.

The rows this slice clears from `docs/spec/delivered.md` are the 24 entries other slices held for `apply`: CLI-138b, CLI-141b, CLI-14b, CLI-31d, CLI-31h, CLI-120b, CLI-125b, CLI-125c, CLI-125d, FAIL-286b, CLI-46b, API-3, API-68, SWAP-34, FAIL-262, TST-39, LOAD-14, LOAD-23, LOAD-25, LOAD-53, LOAD-72, LOAD-92, REC-25 and TST-202. Each is built. The ones a scenario runs carry their id in a test title: CLI-120b, CLI-125b to CLI-125d, CLI-138b, LOAD-14, LOAD-23, LOAD-53, TST-39 and TST-202 in `test/daemon/apply.test.ts`, and API-68 and LOAD-25 in earlier slices' tests. The other twelve need no test of their own under the contract: CLI-141b, CLI-14b, CLI-31d, CLI-31h, FAIL-286b, CLI-46b, API-3, SWAP-34, FAIL-262, LOAD-72, LOAD-92 and REC-25.

New builder rules:

- SWAP-154 (`docs/spec/08-apply-and-swap.md`). A close that SWAP-47 abandoned goes on and the daemon still owns it. The swap does not wait for it, and a later graceful stop does, up to the stop's deadline, which exits 1. Review changed it from a close that went on detached and that no stop waited for.
- REC-154 (`docs/spec/09-repo-and-recovery.md`). A revert that would write over a file its save did not capture, or put one under it, is refused before its commit. A file made or edited after the save, ignored or not, stays whenever it appears. When one is in the way the revert keeps its commit, leaves that file, puts the others back and names what it left.

## What changed

- `src/Repo.ts`: the repo under `repo/work/`, its first commit, the snapshot through a temporary index, the export under a temporary name, the commit on `applied` with a `Chad-Session` trailer, the reset of `work/` after an apply, the saved refs under `refs/chad/saved/`, the check and the restore of a revert against the tree it saved, the prune of older trees, and `state`, which `chad status` and `chad log` read.
- `src/daemon/Apply.ts`: `apply`, `check`, `revert`, `safe`, `reload` and `owners`, each through the one queue. An apply's commit and everything after it run on a fiber of the daemon's scope that the client cannot cut (`owned`), and so do `safe on|off` once the toggle is stored and the plugin rebuild after an owner change. A stop still cuts them. The line in the session's thread is forked and not waited for, and `/safe` typed in chat posts none.
- `src/daemon/Plugins.ts`: `prepare` builds what a plan needs and gives a swap to run or discard. The swap closes the gates, drains under one deadline, interrupts what is left, closes the old scopes under the close deadline and activates the new versions. A close past its deadline goes on in the plugins' scope, so a stop waits for it up to the stop's deadline. With `keep`, a new version that takes a tool name from a version that stays fails too. The tool wrapper refuses a call to a version a swap retired and cuts a call that outlives the drain. The hook queues belong to the plugin's name. A job stops at the callback a swap cut, and an interrupt ends the job, not the queue. `abandon` is what a graceful stop calls first. A plugin that kept its version after a failed owner rebuild or reload is marked in `chad status`.
- `src/SafeMode.ts`: `state/safe-mode`, read before SQLite and written by temporary file and rename. `CHAD_SAFE_MODE` is read once, when `runDaemon` starts (`src/daemon/Environment.ts`).
- CLI commands: `apply`, `check`, `revert`, `log`, `safe` and `plugin reload` (`src/cli/commands/`). `chad log` reads the commits through `src/cli/Repository.ts` and works with no daemon.
- `chad status`: the `repository` block (safe mode and why, the applied commit, whether `work/` holds a draft), with and without a daemon.
- `src/daemon/runDaemon.ts`: the boot settles `live` against the head of `applied`, loads nothing from the repo in safe mode, rebuilds the plugins when an owner changes, and logs `boot.setup-needed` when the volume has no chat connection.
- The apply output counts each affected session's sub-agents and background tasks.

Notes for review:

- Every activation of the swap path bumps the generation, including a swap with nothing to build or remove, so `chad safe on` on an empty repo still renders the prompt again (SWAP-27, SWAP-126).
- A turn waits on a running swap for at most the drain deadline plus the close deadline, which is 40 seconds with the default `Timings`.
- An owner change rebuilds every plugin. When an owner was removed, a plugin whose build fails is unloaded. When one was added, it keeps its running version and `chad status` marks it.
- Six existing tests changed. `test/daemon/cli.test.ts` and `test/daemon/db.test.ts` expect the new `repository` facts in `chad status`. `test/daemon/loader.test.ts` and `test/process/stop.test.ts` make their applied tree through the repo with `test/support/applied.ts`. `test/process/absent.test.ts` expects the unknown subcommand under `plugin`, which is now a command. `test/process/cli.test.ts` uses `frob` as its unknown command, since `apply` is now a command, and gives its fake CLI a `Repository`. `test/unit/loader.test.ts` reads `errors` from `Loader.check`, which now also gives the loaded plugins. `test/unit/harness.test.ts` lists `safeMode` among the environment's keys. Review added one test to `test/process/stop.test.ts`, for SWAP-154.

Fixed while building, each with a regression test. For CLI-120b, SWAP-101 and SWAP-154 the test was run against the code without the fix and failed.

- CLI-125b: `/status` captured the repository facts before the boot set them, so it never showed them. The server now reads them when it answers. `test/daemon/cli.test.ts`.
- REC-153, CLI-169: `CHAD_SAFE_MODE` was read after the harness had put the environment back, so it never held safe mode on. It is now read when `runDaemon` starts. `test/daemon/apply.test.ts`.
- SWAP-101: a stop that came before the swap had begun missed the abandon, and the swap then ran. An abandoned swap that has not begun now discards its builds. `test/daemon/apply.test.ts`.
- CLI-120b, SWAP-99: a removed owner's plugin that failed to rebuild kept its old version, which still knew the removed owner. It is now unloaded. `test/daemon/apply.test.ts`.
- SWAP-154: the scenario's stop waited on a close that the swap had abandoned, and the fix ran that close detached. Review found that a detached close escapes the stop's deadline, so the close is owned again and the stop waits for it up to that deadline (below). `test/daemon/apply.test.ts`.

Fixed in review of `7fb01f7`, each with a regression folded into an existing scenario. Each test was run against the code without its fix and failed.

- REC-139, REC-154: a revert reset `work/` with `reset --hard` and `clean -fd`, so it overwrote an ignored file at a path the target holds and deleted a file made after its save. It now refuses before its commit when a path the target adds holds something the save lacks, and puts the files back from an index of the save, which changes only files that still match it. Scenario 1 of `test/daemon/apply.test.ts`, with the commit held by a git hook while a draft is written. The second and third reviews found gaps in this, below.
- CLI-43, REC-34: the commit ran in the cancellable caller, so a client killed after `applied` moved left `live` and the running version on the old tree. The commit now runs inside the client-proof region. `test/daemon/apply.test.ts`, the killed-CLI scenario, which now kills the CLI while a git hook holds the commit.
- CLI-120b, SWAP-99: a client killed during the plugin rebuild of an owner removal cancelled the rebuild, and the plugin kept the removed owner. The rebuild is now client-proof. The owner scenario kills the CLI during that rebuild.
- REC-56: a client killed during `chad safe on` left the repo's plugins loaded behind a stored `on`. The swap after the stored toggle is now client-proof. The killed-CLI scenario.
- SWAP-154, IMG-82: the detached close of a version a swap abandoned escaped the stop. A finalizer that holds the event loop kept the process alive after `stop.ended`. The close now runs in the plugins' scope, so the stop waits for it and its deadline exits 1. A child-process test in `test/process/stop.test.ts`, and the in-process scenario now ends that close before its stop.
- SWAP-81, SWAP-82, API-64: after the drain cut one callback of a job, the next callback started on the closing version, and the close's interrupt ended the plugin's queue for good. A job now stops at a retired version, and an interrupt ends the job and not the queue. The hook scenario gives each version a second afterTurn, the second version's interrupting itself.
- API-33: with `keep`, a rebuilt plugin could take a tool name from a plugin whose rebuild failed and whose old version stayed, and shadow it. Such a version now fails as well and keeps its running version. The owner scenario.

The SWAP-101 scenario waited only for `applied` to move, so a stop could land before the link moved, and it never restarted. It now waits until `live` and the index of `work/` name the new tree, the steps right before the swap, and boots a second daemon that runs the new version.

Fixed in review of `91cebff`, each with a regression folded into an existing scenario that failed with its fix taken out:

- REC-139, REC-154: the check before the commit looked only at the full path the target adds, so an ignored file named `notes` where the target puts `notes/entry.txt` passed it. The check now also refuses a parent directory that `work/` holds as a file or a link, unless it is a file of the save that the target deletes, and a directory where the target puts a file when it holds anything but files of the save. Scenario 1 of `test/daemon/apply.test.ts` refuses a revert past an ignored parent. This fix also made the restore a `git checkout --no-overwrite-ignore`, and said git checks every path as it writes it. That was wrong: the third review showed that checkout checks the paths before it writes them, so a file made at one path while it writes another is overwritten. That restore is gone (below).
- CLI-120b, SWAP-99: a `chad connection remove` (or `owner remove`) whose client went away before the rebuild began stored the change and skipped the rebuild, because the rebuild was called after the region that a client cannot cut. The rebuild now runs inside that region, on the daemon's fiber that `owned` forks, which a stop can still interrupt. The owner scenario removes a Discord connection whose teardown is held, kills its CLI, and then sees the connection's owner gone from the plugin. `test/support/driver.ts` gained `closing`, a finalizer for a named connection's chat layer.

Fixed in review of `3242d9b`, with its regression folded into scenario 1:

- REC-139, REC-154: `git checkout` overwrote an ignored file made at one of the target's paths while it was still writing another, and reported a normal restore. `checkout` checks the paths it writes before it writes them, so the restore no longer lets git write into `work/`. `Repo.restore` has `checkout-index` write the target's changed files into a directory of its own under `repo/`. Then it changes `work/` with renames and links only. Each file the save held at a path the revert replaces or deletes is renamed aside and hashed. If it still matches the save it is deleted, and if not it is linked back and left. Each file of the target is linked into place, and a link fails where the path holds anything, so it never writes over a file made at any moment. Directories the moves emptied are removed with `rmdir`, which fails on one that holds anything. A revert whose files were in the way now puts the others back and names the ones it left, in place of putting nothing back. The regression holds the restore in a smudge filter while git writes `notes/entry.txt`, and writes an ignored `notes/more.txt` and an edit to the tracked `readme.md` meanwhile. Both stay, `notes/entry.txt` is put back, and the output names the two. It fails with the link swapped for a rename, which replaces, and with the comparison taken out. With the `3242d9b` checkout put back it hangs instead, since that checkout's own git directory does not read the filter, and the reviewer's probe covers that version.

What `restore` keeps is what `work/` holds by path at each moment. It does not cover a write through a file descriptor that a program opened on a file the save captured, before the revert moved that file, and that lands after the move was compared. Those bytes go to the moved file, which the revert then deletes. Every deletion has the same limit, the owner's own `rm` included. A kill during the restore leaves what was moved aside under `repo/.restore-<id>/old/`, and `work/` then lacks the files not yet linked in, which `git status` shows against the revert's commit.

## Tests

`test/daemon/apply.test.ts` has nine scenarios:

- An apply commits `work/` and loads it at the session's next turn, a failed apply (a type error, a Layer that never builds) exits 1 and keeps the last good version, a revert that would write over an ignored file, or put one under it, is refused, a revert saves `work/` first, leaves ignored files alone, and keeps a file made or edited after its save, an ignored one included, while the files around it are put back, and safe mode from chat and from the CLI unloads the repo's plugins until it goes off.
- A swap interrupts a call that outlives the drain, the running turn keeps its tools and gets the refusal, a command behind it waits in the queue and says so, and the next turn has the new version.
- A boot after a crash between an apply's commit and its link loads the head of `applied`.
- An apply whose CLI is SIGKILLed once its commit moved `applied` still finishes in the daemon, and `chad safe on` whose CLI is killed in its drain still unloads the repo's plugins.
- On the Codex side, a swap rebuilds the session's Agent and keeps its socket.
- An owner change rebuilds the plugins with the new owners, a removed connection's owner leaves the plugins even when its CLI is killed during the teardown, a failed rebuild after an add keeps the old version and marks it, a rebuilt plugin cannot take that version's tool name, and a failed rebuild after a removal unloads the plugin even when the CLI is killed during it.
- A check refuses `AGENTS.md` in `work/` and a plugin with a bundled plugin's name, and `CHAD_SAFE_MODE=1` holds safe mode on against `chad safe off`.
- A hook running at a swap is cut at the drain deadline, the hook queued behind it runs on the new version, a turn that starts while the old version's close hangs waits for the new one, the close is abandoned at its deadline, the rest of a cut job does not start on the old version, a hook that interrupts itself leaves its queue running, and a hook of a kind the next version lacks is dropped.
- A graceful stop while an apply's swap waits on a call in flight abandons the swap, and the next boot loads and runs what the apply committed.

`test/process/stop.test.ts` adds one test: a close a swap abandoned that holds the event loop is still owned at the stop, and the deadline exits 1.

## Overview and architecture (00)

| Rule  | Status | Where                                                                                             | Test |
| ----- | ------ | ------------------------------------------------------------------------------------------------- | ---- |
| OV-7  | built  | `src/daemon/Plugins.ts` `prepare`, `swap`                                                         |      |
| OV-8  | built  | nothing: there is no file watcher, and only a CLI command or its chat form changes what is loaded |      |
| OV-31 | built  | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |      |

## Docker image and data volume layout (01)

| Rule   | Status | Where                                            | Test |
| ------ | ------ | ------------------------------------------------ | ---- |
| IMG-33 | built  | `src/daemon/runDaemon.ts` `boot.setup-needed`    |      |
| IMG-43 | built  | `src/daemon/RepoLinks.ts`, `scripts/examples.ts` |      |
| IMG-47 | built  | `src/daemon/RepoLinks.ts`, `scripts/examples.ts` |      |
| IMG-81 | built  | `src/daemon/runDaemon.ts` the stop               |      |

## Storage on the data volume (02)

| Rule    | Status | Where                                            | Test |
| ------- | ------ | ------------------------------------------------ | ---- |
| STO-8   | built  | `src/daemon/RepoLinks.ts`, `scripts/examples.ts` |      |
| STO-13  | built  | `src/SafeMode.ts`                                |      |
| STO-14  | built  | `src/SafeMode.ts`                                |      |
| STO-15  | built  | `src/SafeMode.ts`                                |      |
| STO-141 | built  | `src/SafeMode.ts`                                |      |

## Sessions and turns (03)

| Rule   | Status | Where                                                          | Test                        |
| ------ | ------ | -------------------------------------------------------------- | --------------------------- |
| SES-35 | built  | `src/daemon/Handler.ts` `/safe`                                |                             |
| SES-54 | built  | `src/daemon/Plugins.ts` `ready`, `src/daemon/SessionEntity.ts` | `test/daemon/apply.test.ts` |

## What a turn looks like in Discord (04)

| Rule   | Status                          | Where                            | Test                          |
| ------ | ------------------------------- | -------------------------------- | ----------------------------- |
| DIS-69 | built                           | `src/plugins/send-file.ts`       | `test/daemon/plugins.test.ts` |
| DIS-83 | built, part held for `settings` | `src/daemon/Apply.ts` `announce` |                               |

## Plugin API (06)

| Rule   | Status                          | Where                                                          | Test                        |
| ------ | ------------------------------- | -------------------------------------------------------------- | --------------------------- |
| API-16 | built                           | `src/daemon/Apply.ts` `owners`, `src/daemon/Connections.ts`    |                             |
| API-23 | built, part held for `settings` | `src/Plugin.ts` `isPlugin`, `src/daemon/Plugins.ts`            |                             |
| API-36 | built                           | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper            |                             |
| API-47 | built                           | `src/daemon/Plugins.ts` `prepare`, `swap`                      |                             |
| API-52 | built                           | `src/daemon/Plugins.ts` `ready`, `src/daemon/SessionEntity.ts` |                             |
| API-64 | built                           | `src/daemon/Plugins.ts` the hook queues, `perform`             | `test/daemon/apply.test.ts` |
| API-65 | built, part held for `settings` | `src/daemon/Plugins.ts` the hook queues, `perform`             | `test/daemon/apply.test.ts` |
| API-66 | built                           | `src/daemon/Plugins.ts` the hook queues, `perform`             |                             |
| API-69 | built                           | `src/daemon/Plugins.ts` `activate`, `Plugin.background`        |                             |
| API-70 | built                           | `src/daemon/Plugins.ts` `activate`, `Plugin.background`        |                             |
| API-81 | built                           | `src/daemon/Plugins.ts` `activate`, `Plugin.background`        |                             |

## Runtime and plugin loading (07)

| Rule    | Status                             | Where                                                                                             | Test                         |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| LOAD-3  | built                              | nothing: there is no file watcher, and only a CLI command or its chat form changes what is loaded |                              |
| LOAD-32 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-33 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-34 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-35 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-36 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-37 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-38 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-39 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-40 | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                              |
| LOAD-42 | built                              | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                                                  |                              |
| LOAD-43 | built                              | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                                                  |                              |
| LOAD-44 | built                              | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                                                  |                              |
| LOAD-45 | built                              | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                                                  |                              |
| LOAD-47 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-50 | built, part held for `settings`    | `src/daemon/Plugins.ts` `prepare`, `swap`                                                         |                              |
| LOAD-51 | built, part held for `settings`    | `src/daemon/Plugins.ts` `prepare`, `swap`                                                         |                              |
| LOAD-52 | built, part held for `timers-cron` | `src/daemon/Plugins.ts` `prepare`, `swap`                                                         |                              |
| LOAD-54 | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                              |
| LOAD-55 | built                              | `src/daemon/Apply.ts` the region after the commit, forked and uninterruptible                     | `test/daemon/apply.test.ts`  |
| LOAD-56 | built                              | `src/daemon/Plugins.ts` `prepare`, `swap`                                                         |                              |
| LOAD-57 | built                              | `src/daemon/Plugins.ts` `activate`, `Plugin.background`                                           |                              |
| LOAD-58 | built                              | `src/daemon/Plugins.ts` `activate`, `Plugin.background`                                           |                              |
| LOAD-59 | built                              | `src/daemon/Plugins.ts` `activate`, `Plugin.background`                                           |                              |
| LOAD-60 | built                              | `src/daemon/Plugins.ts` `track`, `swap.overrun`                                                   |                              |
| LOAD-61 | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   | `test/daemon/loader.test.ts` |
| LOAD-62 | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                              |
| LOAD-63 | built, part held for `settings`    | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                              |
| LOAD-67 | built                              | `src/daemon/Plugins.ts` `activate`, `Plugin.background`                                           |                              |
| LOAD-70 | built                              | `src/daemon/Apply.ts` `announce`, `Messages.appliedLine`                                          | `test/daemon/apply.test.ts`  |
| LOAD-75 | built                              | `src/daemon/Plugins.ts` `prepare`, `swap`                                                         | `test/daemon/apply.test.ts`  |
| LOAD-82 | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                              |
| LOAD-83 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                              |
| LOAD-84 | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                              |
| LOAD-88 | built, part held for `settings`    | `src/daemon/Plugins.ts` `prepare`, `swap`                                                         |                              |
| LOAD-89 | built                              | `src/Repo.ts` `state`, `src/daemon/runDaemon.ts` step 9                                           | `test/daemon/apply.test.ts`  |
| LOAD-90 | built                              | `src/daemon/runDaemon.ts` step 9 (no esbuild in safe mode)                                        |                              |
| LOAD-91 | built                              | `src/daemon/Apply.ts` `refused`, `errorLines`                                                     |                              |
| LOAD-93 | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                              |
| LOAD-94 | built                              | `src/daemon/Loader.ts` `check`, `instructions`                                                    | `test/daemon/apply.test.ts`  |
| LOAD-95 | built                              | `src/daemon/Loader.ts` `check`, `instructions`                                                    |                              |
| LOAD-96 | built                              | `src/daemon/Loader.ts` `check`, `instructions`                                                    |                              |
| LOAD-97 | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                              |

## Applying a change to live sessions (08)

| Rule     | Status                            | Where                                                                                | Test                                                     |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| SWAP-1   | built                             | `src/daemon/Apply.ts` `apply`, `check`                                               | `test/daemon/apply.test.ts`                              |
| SWAP-2   | built                             | `src/daemon/Apply.ts` `apply`, `check`                                               | `test/daemon/apply.test.ts`                              |
| SWAP-3   | built                             | `src/daemon/Plugins.ts` `prepare` (`trial`), `src/Trial.ts`                          |                                                          |
| SWAP-6   | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  | `test/daemon/apply.test.ts`                              |
| SWAP-7   | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-27  | built                             | `src/daemon/SessionEntity.ts` the prompt, `Messages.safePrompt`                      |                                                          |
| SWAP-39  | built, part held for `settings`   | `src/daemon/Plugins.ts` `prepare`, `swap`                                            |                                                          |
| SWAP-40  | built                             | `src/daemon/Queue.ts`                                                                |                                                          |
| SWAP-41  | built, part held for `settings`   | `src/daemon/Plugins.ts` `prepare`, `swap`                                            |                                                          |
| SWAP-42  | built                             | `src/daemon/Apply.ts` `apply`, `check`                                               |                                                          |
| SWAP-43  | built                             | `src/daemon/Plugins.ts` `prepare`, `swap`                                            |                                                          |
| SWAP-44  | built                             | `src/daemon/Plugins.ts` `prepare`, `swap`                                            | `test/daemon/apply.test.ts`                              |
| SWAP-45  | built                             | `src/daemon/Plugins.ts` `prepare`, `swap`                                            |                                                          |
| SWAP-46  | built                             | `src/daemon/Plugins.ts` `prepare`, `swap`                                            | `test/daemon/apply.test.ts`                              |
| SWAP-47  | built                             | `src/daemon/Plugins.ts` `close`                                                      | `test/daemon/apply.test.ts`                              |
| SWAP-48  | built                             | `src/daemon/Plugins.ts` `prepare`, `swap`                                            |                                                          |
| SWAP-49  | built                             | `src/daemon/Plugins.ts` `activate`, `Plugin.background`                              |                                                          |
| SWAP-50  | built                             | `src/daemon/Plugins.ts` `activate`, `Plugin.background`                              |                                                          |
| SWAP-51  | built                             | `src/daemon/Plugins.ts` `activate`, `Plugin.background`                              |                                                          |
| SWAP-52  | built                             | `src/daemon/Plugins.ts` `track`, `swap.overrun`                                      |                                                          |
| SWAP-53  | built                             | `src/daemon/Plugins.ts` `track`, `swap.overrun`                                      |                                                          |
| SWAP-55  | built                             | `src/daemon/Apply.ts` the region after the commit, forked and uninterruptible        |                                                          |
| SWAP-56  | built                             | `src/daemon/Apply.ts` the region after the commit, forked and uninterruptible        |                                                          |
| SWAP-57  | built                             | `src/daemon/Apply.ts` `apply`, `check`                                               |                                                          |
| SWAP-59  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-60  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-69  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  | `test/daemon/apply.test.ts`                              |
| SWAP-70  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-71  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-72  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-75  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-76  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-77  | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-78  | built                             | `src/Messages.ts` `appliedOutput`                                                    |                                                          |
| SWAP-79  | built                             | `src/daemon/Plugins.ts` the hook queues, `perform`                                   | `test/daemon/apply.test.ts`                              |
| SWAP-80  | built                             | `src/daemon/Plugins.ts` the hook queues, `perform`                                   |                                                          |
| SWAP-81  | built                             | `src/daemon/Plugins.ts` the hook queues, `perform`, which stops at a retired version | `test/daemon/apply.test.ts`                              |
| SWAP-82  | built                             | `src/daemon/Plugins.ts` the hook queues, `perform`                                   | `test/daemon/apply.test.ts`                              |
| SWAP-83  | built                             | `src/daemon/Plugins.ts` the hook queues, `perform`                                   | `test/daemon/apply.test.ts`                              |
| SWAP-85  | built                             | `src/daemon/Plugins.ts` the hook queues, `perform`                                   |                                                          |
| SWAP-87  | built                             | `src/daemon/Plugins.ts` `ready`, `src/daemon/SessionEntity.ts`                       | `test/daemon/apply.test.ts`                              |
| SWAP-88  | built                             | `src/daemon/Plugins.ts` `ready`, `src/daemon/SessionEntity.ts`                       | `test/daemon/apply.test.ts`                              |
| SWAP-89  | built                             | `src/daemon/Plugins.ts` `ready`, `src/daemon/SessionEntity.ts`                       |                                                          |
| SWAP-95  | built                             | `src/daemon/Apply.ts` `reload`                                                       |                                                          |
| SWAP-99  | built                             | `src/daemon/Apply.ts` `owners`, `src/daemon/Connections.ts`                          | `test/daemon/apply.test.ts`                              |
| SWAP-100 | built                             | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                      |                                                          |
| SWAP-101 | built                             | `src/daemon/Plugins.ts` `abandon`, `src/daemon/runDaemon.ts` the stop                | `test/daemon/apply.test.ts`                              |
| SWAP-102 | built                             | `src/daemon/Apply.ts` the region after the commit, forked and uninterruptible        |                                                          |
| SWAP-103 | built                             | `src/daemon/Plugins.ts` `abandon`, `src/daemon/runDaemon.ts` the stop                | `test/daemon/apply.test.ts`                              |
| SWAP-104 | built                             | `src/daemon/Plugins.ts` `abandon`, `src/daemon/runDaemon.ts` the stop                |                                                          |
| SWAP-105 | built                             | `src/daemon/Plugins.ts` `abandon`, `src/daemon/runDaemon.ts` the stop                |                                                          |
| SWAP-106 | built                             | `src/daemon/Plugins.ts` `abandon`, `src/daemon/runDaemon.ts` the stop                |                                                          |
| SWAP-109 | built, part held for `skills-mcp` | `src/daemon/Plugins.ts` `abandon`, `src/daemon/runDaemon.ts` the stop                |                                                          |
| SWAP-112 | built                             | `src/Messages.ts` `appliedOutput`                                                    |                                                          |
| SWAP-113 | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  | `test/daemon/apply.test.ts`                              |
| SWAP-114 | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  |                                                          |
| SWAP-115 | built                             | `test/daemon/apply.test.ts`, which holds the first hook open until the removal       | `test/daemon/apply.test.ts`                              |
| SWAP-118 | built                             | `src/Timings.ts`                                                                     |                                                          |
| SWAP-119 | built                             | `src/daemon/Plugins.ts` `track`, `swap.overrun`                                      |                                                          |
| SWAP-120 | built                             | `src/Events.ts`                                                                      |                                                          |
| SWAP-121 | built, part held for `settings`   | `src/daemon/Apply.ts` `announce`                                                     |                                                          |
| SWAP-123 | simplified                        | `src/Messages.ts` `toolChanged` to `toolCut`                                         |                                                          |
| SWAP-125 | built                             | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                 |                                                          |
| SWAP-126 | built                             | `src/daemon/Plugins.ts` `prepare`, `swap`                                            |                                                          |
| SWAP-141 | built                             | `src/daemon/Plugins.ts` `status`, `src/Status.ts`                                    | `test/daemon/apply.test.ts`                              |
| SWAP-142 | built                             | `src/daemon/Plugins.ts` `status`, `src/Status.ts`                                    |                                                          |
| SWAP-147 | built                             | `src/daemon/Apply.ts` `refused`, `errorLines`                                        |                                                          |
| SWAP-152 | built                             | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                      |                                                          |
| SWAP-153 | built                             | `src/daemon/Plugins.ts` `toolsOf`, the tool wrapper                                  | `test/daemon/apply.test.ts`                              |
| SWAP-154 | built (new builder rule)          | `src/daemon/Plugins.ts` `close`                                                      | `test/daemon/apply.test.ts`, `test/process/stop.test.ts` |

## The repo, applying, and recovering from a bad self-edit (09)

| Rule    | Status                             | Where                                                                                             | Test                                                     |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| REC-3   | built                              | nothing: there is no file watcher, and only a CLI command or its chat form changes what is loaded |                                                          |
| REC-4   | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                                                          |
| REC-5   | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                                                          |
| REC-6   | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                                                          |
| REC-8   | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                                                          |
| REC-9   | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-10  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-11  | built, part held for `skills-mcp`  | `src/daemon/Loader.ts` `load`, `src/daemon/Apply.ts`                                              |                                                          |
| REC-12  | built                              | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                                                  |                                                          |
| REC-14  | built                              | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                                                  |                                                          |
| REC-15  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-16  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-17  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-18  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-19  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-20  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-22  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-23  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-24  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-26  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                                                          |
| REC-29  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                                                          |
| REC-30  | built                              | `src/daemon/Loader.ts` `check`, `instructions`                                                    |                                                          |
| REC-31  | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-32  | built                              | `src/Repo.ts` `commit` (the `Chad-Session` trailer), `src/daemon/Apply.ts` `apply`                |                                                          |
| REC-33  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                                                          |
| REC-34  | built                              | `src/daemon/Apply.ts` the region after the commit, forked and uninterruptible                     | `test/daemon/apply.test.ts`                              |
| REC-35  | built                              | `src/daemon/Apply.ts` the region after the commit, forked and uninterruptible                     |                                                          |
| REC-36  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                                                          |
| REC-37  | built                              | `src/daemon/Queue.ts`                                                                             |                                                          |
| REC-38  | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                                                          |
| REC-39  | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                                                          |
| REC-40  | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                                                          |
| REC-41  | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                                                          |
| REC-42  | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   | `test/daemon/loader.test.ts`, `test/unit/loader.test.ts` |
| REC-44  | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                                                          |
| REC-48  | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   | `test/daemon/apply.test.ts`, `test/unit/loader.test.ts`  |
| REC-50  | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                                                          |
| REC-54  | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                                                          |
| REC-55  | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                                                          |
| REC-56  | built                              | `src/SafeMode.ts`, `src/daemon/Apply.ts` `switched`, run by `owned`                               | `test/daemon/apply.test.ts`                              |
| REC-57  | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                                                          |
| REC-58  | built                              | `src/daemon/SessionEntity.ts` the prompt, `Messages.safePrompt`                                   |                                                          |
| REC-59  | built, part held for `timers-cron` | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                                                          |
| REC-60  | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                                                          |
| REC-61  | built                              | `src/daemon/Handler.ts` `/safe`                                                                   |                                                          |
| REC-62  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                                                          |
| REC-71  | built                              | nothing: there is no such command                                                                 |                                                          |
| REC-78  | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                                                          |
| REC-79  | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                                                          |
| REC-80  | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                                                          |
| REC-81  | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                                                          |
| REC-82  | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              | `test/daemon/apply.test.ts`                              |
| REC-83  | built                              | nothing: connections, owners and secrets live outside the repo                                    |                                                          |
| REC-84  | built                              | nothing: there is no such command                                                                 |                                                          |
| REC-86  | built                              | `src/cli/commands/log.ts`, `src/cli/Repository.ts`                                                | `test/daemon/apply.test.ts`                              |
| REC-94  | built                              | nothing: connections, owners and secrets live outside the repo                                    |                                                          |
| REC-104 | built                              | `src/daemon/Apply.ts` `announce`, `Messages.appliedLine`                                          |                                                          |
| REC-106 | built                              | `src/daemon/runDaemon.ts` (a crash posts nothing)                                                 |                                                          |
| REC-107 | built                              | `src/Timings.ts`                                                                                  |                                                          |
| REC-108 | built, part held for `settings`    | `src/daemon/Apply.ts` `announce`                                                                  |                                                          |
| REC-111 | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                                                          |
| REC-112 | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                                                          |
| REC-113 | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                                                          |
| REC-114 | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                                                          |
| REC-115 | built                              | `src/Repo.ts` `prepare`, the first commit and the repo's git identity                             |                                                          |
| REC-116 | built                              | `src/Repo.ts` `commit` (the `Chad-Session` trailer), `src/daemon/Apply.ts` `apply`                | `test/daemon/apply.test.ts`                              |
| REC-117 | built                              | `src/daemon/Apply.ts` `announce`, `Messages.appliedLine`                                          |                                                          |
| REC-118 | built                              | `src/daemon/Apply.ts` `announce`, `Messages.appliedLine`                                          |                                                          |
| REC-119 | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                                                          |
| REC-120 | built                              | `src/daemon/Apply.ts` the region after the commit, forked and uninterruptible                     |                                                          |
| REC-121 | built                              | `src/Repo.ts` `state`, `src/daemon/runDaemon.ts` step 9                                           |                                                          |
| REC-122 | built                              | `src/daemon/Apply.ts` `reload`                                                                    |                                                          |
| REC-123 | built                              | `src/daemon/Apply.ts` `reload`                                                                    |                                                          |
| REC-125 | built                              | `src/daemon/Apply.ts` `reload`                                                                    |                                                          |
| REC-127 | built                              | `src/SafeMode.ts`                                                                                 |                                                          |
| REC-128 | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                                                          |
| REC-129 | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   | `test/daemon/apply.test.ts`                              |
| REC-135 | built                              | `src/daemon/Plugins.ts` `run` (each version starts its own count)                                 |                                                          |
| REC-136 | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                                                          |
| REC-137 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                | `test/daemon/apply.test.ts`                              |
| REC-138 | built                              | `src/Repo.ts` `snapshot`, `exportTree`, `commit`, `reset`, `prune`                                |                                                          |
| REC-139 | built                              | `src/Repo.ts` `save`, `obstructed`, `restore`                                                     | `test/daemon/apply.test.ts`                              |
| REC-140 | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                                                          |
| REC-141 | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                                                          |
| REC-142 | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                                                          |
| REC-143 | built                              | `src/cli/commands/log.ts`, `src/cli/Repository.ts`                                                |                                                          |
| REC-144 | built                              | `src/cli/commands/log.ts`, `src/cli/Repository.ts`                                                |                                                          |
| REC-146 | built                              | `src/daemon/Apply.ts` `apply`, `Logger.event("apply.done")`                                       |                                                          |
| REC-147 | built                              | `src/daemon/Queue.ts`                                                                             |                                                          |
| REC-149 | built                              | `src/Paths.ts`                                                                                    |                                                          |
| REC-150 | built                              | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9                                   |                                                          |
| REC-152 | built                              | `src/daemon/Loader.ts` `check`, `instructions`                                                    | `test/daemon/apply.test.ts`                              |
| REC-153 | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   | `test/daemon/apply.test.ts`                              |
| REC-154 | built (new builder rule)           | `src/daemon/Apply.ts` `change`, `src/Repo.ts` `obstructed`, `restore`                             | `test/daemon/apply.test.ts`                              |

## The chad CLI (10)

| Rule    | Status                             | Where                                                                                             | Test                        |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| CLI-3   | built                              | nothing: there is no file watcher, and only a CLI command or its chat form changes what is loaded |                             |
| CLI-6   | built                              | `src/daemon/runDaemon.ts` `boot.setup-needed`                                                     |                             |
| CLI-32  | built, part held for `skills-mcp`  | `src/cli/Commands.ts` (no daemon: exit 4)                                                         |                             |
| CLI-40  | built                              | `src/daemon/Queue.ts`                                                                             | `test/daemon/apply.test.ts` |
| CLI-41  | built                              | `src/daemon/Queue.ts`                                                                             |                             |
| CLI-43  | built                              | `src/daemon/Apply.ts` `owned`, which runs the commit and everything after it                      | `test/daemon/apply.test.ts` |
| CLI-44  | built                              | `src/daemon/Apply.ts` the region after the commit, forked and uninterruptible                     | `test/daemon/apply.test.ts` |
| CLI-47  | built                              | `src/daemon/Apply.ts` `refused`, `errorLines`                                                     |                             |
| CLI-63  | built                              | `src/Repo.ts` `commit` (the `Chad-Session` trailer), `src/daemon/Apply.ts` `apply`                |                             |
| CLI-64  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                             |
| CLI-65  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                             |
| CLI-66  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                             |
| CLI-67  | built, part held for `skills-mcp`  | `src/daemon/Loader.ts` `check`, `src/Messages.ts`                                                 |                             |
| CLI-68  | built, part held for `skills-mcp`  | `src/daemon/Loader.ts` `check`, `src/Messages.ts`                                                 |                             |
| CLI-69  | built                              | `src/daemon/Apply.ts` `refused`, `errorLines`                                                     |                             |
| CLI-70  | built, part held for `skills-mcp`  | `src/Messages.ts` `appliedOutput`                                                                 |                             |
| CLI-71  | built, part held for `timers-cron` | `src/Messages.ts` `appliedOutput`                                                                 |                             |
| CLI-73  | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                             |
| CLI-76  | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                             |
| CLI-77  | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                             |
| CLI-78  | built                              | `src/daemon/Apply.ts` `revert`, `src/Repo.ts` `save`                                              |                             |
| CLI-79  | built                              | nothing: connections, owners and secrets live outside the repo                                    |                             |
| CLI-80  | built                              | `src/cli/commands/log.ts`, `src/cli/Repository.ts`                                                |                             |
| CLI-81  | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                             |
| CLI-82  | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                             |
| CLI-83  | built                              | nothing: there is no such command                                                                 |                             |
| CLI-86  | held for `skills-mcp`              | nothing yet                                                                                       |                             |
| CLI-87  | held for `skills-mcp`              | nothing yet                                                                                       |                             |
| CLI-88  | built, part held for `settings`    | `src/daemon/Apply.ts` `reload`                                                                    |                             |
| CLI-139 | built                              | `src/daemon/Handler.ts` `/safe`                                                                   |                             |
| CLI-150 | built, part held for `settings`    | `src/daemon/Apply.ts` `announce`                                                                  |                             |
| CLI-158 | held for `settings`                | `src/cli/Commands.ts` (no daemon: exit 4)                                                         |                             |
| CLI-163 | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                             |
| CLI-164 | built                              | `src/daemon/Apply.ts` `apply`, `check`                                                            |                             |
| CLI-165 | built                              | `src/cli/commands/log.ts`, `src/cli/Repository.ts`                                                |                             |
| CLI-166 | built                              | `src/cli/commands/log.ts`, `src/cli/Repository.ts`                                                |                             |
| CLI-167 | built                              | `src/cli/commands/log.ts`, `src/cli/Repository.ts`                                                |                             |
| CLI-168 | built                              | `src/cli/commands/log.ts`, `src/cli/Repository.ts`                                                |                             |
| CLI-169 | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                             |
| CLI-170 | built                              | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                                                   |                             |
| CLI-171 | built                              | `src/daemon/Apply.ts` `reload`                                                                    |                             |

## Plugin settings (11)

| Rule   | Status                            | Where                                                           | Test |
| ------ | --------------------------------- | --------------------------------------------------------------- | ---- |
| SET-54 | built, part held for `skills-mcp` | `src/daemon/Loader.ts` `check`, `Messages.bundledNameRefused`   |      |
| SET-61 | built                             | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9 |      |

## The bundled self-edit skill and the persona (14)

| Rule     | Status                          | Where                                                                 | Test                        |
| -------- | ------------------------------- | --------------------------------------------------------------------- | --------------------------- |
| SELF-19  | built                           | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                      |                             |
| SELF-20  | built                           | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                      |                             |
| SELF-21  | built                           | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                      |                             |
| SELF-24  | built                           | `src/daemon/RepoLinks.ts`, `scripts/examples.ts`                      |                             |
| SELF-32  | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-33  | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-34  | built                           | `src/daemon/Apply.ts` `refused`, `errorLines`                         |                             |
| SELF-35  | built                           | `src/daemon/Apply.ts` `refused`, `errorLines`                         |                             |
| SELF-38  | built                           | `src/daemon/SessionEntity.ts` the prompt, `Messages.safePrompt`       | `test/daemon/apply.test.ts` |
| SELF-39  | built                           | `src/daemon/SessionEntity.ts` the prompt, `Messages.safePrompt`       |                             |
| SELF-44  | built                           | `src/Repo.ts` `prepare`, the first commit and the repo's git identity |                             |
| SELF-47  | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-48  | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-49  | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-50  | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-51  | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-52  | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-54  | built                           | `src/daemon/Apply.ts` `apply`, `check`                                |                             |
| SELF-73  | built                           | `src/daemon/Apply.ts` `safe`, `src/SafeMode.ts`                       |                             |
| SELF-110 | held for `skills-mcp`           | nothing yet                                                           |                             |
| SELF-126 | built, part held for `settings` | `src/daemon/Apply.ts` `announce`                                      |                             |

## Failures, logs and status (16)

| Rule     | Status                          | Where                                                           | Test |
| -------- | ------------------------------- | --------------------------------------------------------------- | ---- |
| FAIL-70  | built                           | `src/daemon/runDaemon.ts` (a crash posts nothing)               |      |
| FAIL-161 | built                           | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9 |      |
| FAIL-177 | built                           | `src/daemon/Apply.ts` `announce`, `Messages.appliedLine`        |      |
| FAIL-178 | built                           | `src/daemon/Apply.ts` `announce`, `Messages.appliedLine`        |      |
| FAIL-179 | built                           | `src/daemon/Apply.ts` `announce`, `Messages.appliedLine`        |      |
| FAIL-180 | built                           | `src/daemon/Apply.ts` `announce`, `Messages.appliedLine`        |      |
| FAIL-181 | built                           | `src/daemon/Plugins.ts` `track`, `swap.overrun`                 |      |
| FAIL-238 | built, part held for `settings` | `src/daemon/Apply.ts` `announce`                                |      |
| FAIL-263 | built                           | `src/daemon/Plugins.ts` `track`, `swap.overrun`                 |      |
| FAIL-264 | built                           | `src/daemon/Plugins.ts` `track`, `swap.overrun`                 |      |
| FAIL-265 | built                           | `src/daemon/Plugins.ts` `close`                                 |      |
| FAIL-266 | built                           | `src/daemon/Apply.ts` `apply`, `Logger.event("apply.done")`     |      |
| FAIL-267 | built                           | `src/daemon/Apply.ts` `refused`, `errorLines`                   |      |
| FAIL-268 | built                           | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9 |      |
| FAIL-288 | built                           | `src/daemon/runDaemon.ts` `boot.setup-needed`                   |      |
| FAIL-318 | built                           | `src/daemon/Loader.ts` `load`, `src/daemon/runDaemon.ts` step 9 |      |

## The asphodel plugin (18)

| Rule    | Status | Where                                | Test                            |
| ------- | ------ | ------------------------------------ | ------------------------------- |
| ASP-44  | built  | `test/fixtures/asphodel/asphodel.ts` | `test/process/asphodel.test.ts` |
| ASP-53  | built  | `test/fixtures/asphodel/asphodel.ts` |                                 |
| ASP-94  | built  | `test/fixtures/asphodel/asphodel.ts` |                                 |
| ASP-108 | built  | `test/fixtures/asphodel/asphodel.ts` |                                 |
| ASP-112 | built  | `test/fixtures/asphodel/asphodel.ts` |                                 |
| ASP-113 | built  | `test/fixtures/asphodel/asphodel.ts` |                                 |
