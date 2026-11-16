# The `loader` slice: the builder's record

This is the builder's record of how the `loader` slice was delivered, kept in the repository so that review can read it. It is not spec. Where it and `docs/spec/` differ, the spec is right and this file is wrong. A test file is named where a test whose title names the id runs it.

It accounts for every id that `node scripts/rule-ids.ts list loader` prints, which is 68 ids: the 64 of the spec as it stood and the four builder rules this slice added, IMG-143, IMG-144, LOAD-98 and FAIL-344.

## Summary

Counts by status:

- built: 60 (4 of them new builder rules)
- built, part held: 8
- simplified: 0
- stopped: 0

No row is NOT BUILT. A "built, part held" row is built except for the clause `docs/spec/delivered.md` holds, and the row names the slice it waits on.

Held, as `docs/spec/delivered.md` lists them:

- `apply`: LOAD-14 (an apply that the deadline fails), LOAD-23, LOAD-25, LOAD-72 and LOAD-92 (`chad check` and `chad apply`, which fail on the check's errors), LOAD-53 and REC-25 (the Layer builds of the changed plugins and the trial `Agent.makeWith`), and TST-202 (the swap code a plugin handed to `runDaemon` shares with repo plugins). `Loader.check` gives the errors in the order of LOAD-98 and LOAD-53, and `test/unit/loader.test.ts` runs it. Nothing calls it from the CLI yet.
- `bundled-skills`: LOAD-20 (the `self-edit` skill that says which packages are promised).

The rows this slice clears from `docs/spec/delivered.md`: REC-101 (the notice for a plugin skipped at load goes to the owner's latest DM, and `test/daemon/loader.test.ts` checks its thread), CLI-42b (the 30 second deadline, `src/Timings.ts` `pluginBuild`), CLI-125e (`chad status` names each skipped plugin and why) and the deadline part of TST-202. TST-202 stays held for `apply`, for the swap.

Earlier slices' rules that now cover repo plugins: API-15 and STO-58, whose repo-plugin part the `plugin-api` record left for this slice. A plugin loaded from `repo/live` goes through the same `Plugins.make` as a bundled one, so its `PluginContext.name` is the name `Loader.discover` gives (API-1) and its table is the table of that name, shared with a bundled plugin of the same name.

Built ahead of its slice: REC-42 (`apply`). A repo plugin whose name a bundled plugin has is skipped with the notice the rule gives (`src/daemon/runDaemon.ts`, `Messages.bundledName`). LOAD-61 (`apply`) is built as far as a boot goes: a boot loads `repo/live` with no type-check.

Notes for review:

- The Dockerfile sketch in `docs/spec/01-image-and-volume.md` runs `ln -s .. node_modules/chad` and `pnpm run check:plugins`. No rule names `check:plugins`. The link is made by `scripts/examples.ts`, which the build runs, and the image layer's TST-188 test type-checks a plugin and the `send-file` example from `/data/repo` with the check's own options.
- `repo/package.json` is written only when it is missing, so an owner's edit to it stays.
- A side-effect import of a missing package fails with TS2882, not TS2307, so the rewrite of LOAD-22 covers both.
- The links and the bundles of the applied tree are made at the start of step 9, before the sessions and the connections start. Their Layers build where the bundled plugins' do. Bundling later held up the connections, and a resumed turn then posted before its connection was there.
- Three existing tests changed. `test/daemon/cli.test.ts` lists the volume without following links, since `repo/node_modules` leads back into the checkout through `node_modules/chad -> ..`. API-33 in `test/daemon/plugins.test.ts` waits for the turn's end, because the skipped plugin's notice now goes to the same direct message. CLI-46a in `test/daemon/db.test.ts` expects `skipped` in `chad status --json`.

## Tests

- `test/daemon/loader.test.ts`: a boot on an applied tree with two plugins that load (one file, one directory with a helper), one whose module throws at load and one that has a bundled plugin's name. The tools run, a tool's error and the load error carry `work/` paths, the skipped plugins get notices and `chad status` lines, and the links under `repo/` are made with what was there moved aside. A second scenario has a plugin whose Layer build waits on a `Turns` call and is skipped at the deadline (1.5 s on the scaled timings), with the others loaded.
- `test/unit/loader.test.ts`: the check passes a tree that imports `chad`, `effect`, `node:fs` and a local `.ts` file, and ignores a `.ts` file outside `plugins/`. It fails a missing package and a type error with `work/` paths, the list of what can be imported and the `AGENTS.md` line.
- `test/types/plugins.test.ts`: the six mistakes of TST-22 and the asphodel fixture, type-checked with `compilerOptions` from `dist`.
- `test/image/image.test.ts`, "the links under repo/ and a plugin's type-check in the image": the links, `repo/package.json`, effect's docs, the examples, no write through the link, and a plugin under `/data/repo` that type-checks while `import "chad/daemon"` does not.

## Overview (00)

| Rule  | Status | Where                                                                                                         | Test                         |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| OV-18 | built  | `src/daemon/Loader.ts` `run` (the host's `createRequire`); the one copy of effect is the `repo` slice's check | `test/daemon/loader.test.ts` |

## Image and volume (01)

| Rule    | Status                   | Where                                                                       | Test                                                     |
| ------- | ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| IMG-11  | built                    | `Dockerfile` (earlier slice), `src/daemon/RepoLinks.ts` `prepare`           | `test/image/image.test.ts`                               |
| IMG-44  | built                    | `src/daemon/RepoLinks.ts` `prepare`, `modules`                              | `test/daemon/loader.test.ts`, `test/image/image.test.ts` |
| IMG-45  | built                    | `src/daemon/RepoLinks.ts` `prepare`, `examples`; `scripts/examples.ts`      | `test/daemon/loader.test.ts`, `test/image/image.test.ts` |
| IMG-46  | built                    | `src/daemon/RepoLinks.ts` `prepare`                                         | `test/daemon/loader.test.ts`                             |
| IMG-48  | built                    | `Dockerfile` (`/opt/chad` belongs to root)                                  | `test/image/image.test.ts`                               |
| IMG-49  | built                    | `scripts/examples.ts` (`node_modules/chad -> ..`), `package.json` `exports` | `test/image/image.test.ts`                               |
| IMG-50  | built                    | `src/daemon/Loader.ts` `run`, `compilerOptions`                             | `test/image/image.test.ts`                               |
| IMG-51  | built                    | `scripts/examples.ts`, `Dockerfile` (`COPY ... /opt/chad/plugins`)          | `test/image/image.test.ts`                               |
| IMG-143 | built (new builder rule) | `src/daemon/RepoLinks.ts` `prepare`                                         | `test/daemon/loader.test.ts`                             |
| IMG-144 | built (new builder rule) | `scripts/examples.ts`                                                       | `test/image/image.test.ts`                               |

## Plugin API (06)

| Rule    | Status | Where                                                                             | Test                         |
| ------- | ------ | --------------------------------------------------------------------------------- | ---------------------------- |
| API-1   | built  | `src/daemon/Loader.ts` `discover`                                                 | `test/daemon/loader.test.ts` |
| API-6   | built  | `src/daemon/Loader.ts` `run` (`Plugin.isPlugin`), `Messages.notPlugin`            | none                         |
| API-10  | built  | `src/daemon/Loader.ts` `typecheck` (`missingPackage`)                             | `test/unit/loader.test.ts`   |
| API-11  | built  | `src/daemon/Loader.ts` `bundle` (CJS), `bundleError`                              | none                         |
| API-13  | built  | `scripts/examples.ts`, `Dockerfile`                                               | `test/image/image.test.ts`   |
| API-131 | built  | `src/daemon/Plugins.ts` `load` (`Effect.timeoutOrElse`), `Messages.buildTimedOut` | `test/daemon/loader.test.ts` |

## Plugin loading (07)

| Rule    | Status                              | Where                                                                                                                                        | Test                                                     |
| ------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| LOAD-4  | built                               | nothing to build: the loader adds no guard, and `chad health` is an earlier slice's                                                          | none                                                     |
| LOAD-5  | built                               | `src/daemon/Loader.ts` `discover`                                                                                                            | `test/daemon/loader.test.ts`                             |
| LOAD-6  | built                               | `src/daemon/Loader.ts` `run`                                                                                                                 | none                                                     |
| LOAD-7  | built                               | `src/daemon/Loader.ts` `bundle`                                                                                                              | `test/daemon/loader.test.ts`                             |
| LOAD-8  | built                               | `src/daemon/Loader.ts` `bundle` (`write: false`); `load` runs at every boot from `src/daemon/runDaemon.ts`                                   | none                                                     |
| LOAD-9  | built                               | `src/daemon/Loader.ts` `bundle` (`packages: "external"`)                                                                                     | `test/daemon/loader.test.ts`                             |
| LOAD-10 | built                               | `src/daemon/Loader.ts` `bundle` (external source map), `mapStack`                                                                            | `test/daemon/loader.test.ts`                             |
| LOAD-11 | built                               | `src/daemon/Loader.ts` `bundle` is the one call of esbuild                                                                                   | none                                                     |
| LOAD-12 | built                               | `src/daemon/Loader.ts` `run` (`vm.compileFunction`)                                                                                          | `test/daemon/loader.test.ts`                             |
| LOAD-13 | built                               | `src/daemon/Plugins.ts` `load` (earlier slice)                                                                                               | none                                                     |
| LOAD-14 | built, part held (`apply`)          | `src/daemon/Plugins.ts` `load`, `src/Timings.ts` `pluginBuild`                                                                               | `test/daemon/loader.test.ts`                             |
| LOAD-16 | built                               | `src/daemon/Loader.ts` `run`                                                                                                                 | `test/daemon/loader.test.ts`                             |
| LOAD-17 | built                               | `src/daemon/Loader.ts` `run`                                                                                                                 | `test/daemon/loader.test.ts`                             |
| LOAD-20 | built, part held (`bundled-skills`) | `src/daemon/RepoLinks.ts` (the whole image `node_modules` is linked)                                                                         | none                                                     |
| LOAD-22 | built                               | `src/daemon/Loader.ts` `typecheck` (`missingPackage`, TS2307 and TS2882)                                                                     | `test/unit/loader.test.ts`                               |
| LOAD-23 | built, part held (`apply`)          | `src/daemon/Loader.ts` `bundleError`, `Messages.topLevelAwait`                                                                               | none                                                     |
| LOAD-24 | built                               | `src/daemon/Loader.ts` `bundle` (esbuild's CJS output empties `import.meta`)                                                                 | none                                                     |
| LOAD-25 | built, part held (`apply`)          | `src/daemon/Loader.ts` `typecheck`, `check`                                                                                                  | `test/unit/loader.test.ts`                               |
| LOAD-26 | built                               | `src/daemon/RepoLinks.ts` `prepare`                                                                                                          | `test/unit/loader.test.ts`, `test/image/image.test.ts`   |
| LOAD-27 | built                               | `src/daemon/RepoLinks.ts` `prepare`                                                                                                          | `test/unit/loader.test.ts`, `test/image/image.test.ts`   |
| LOAD-28 | built                               | `scripts/examples.ts`                                                                                                                        | `test/image/image.test.ts`                               |
| LOAD-29 | built                               | `src/daemon/Loader.ts` `typecheck` (writes `<tree>.tsconfig.json` beside the tree and removes it)                                            | `test/unit/loader.test.ts`                               |
| LOAD-30 | built                               | `src/daemon/Loader.ts` `toWork`                                                                                                              | `test/unit/loader.test.ts`                               |
| LOAD-31 | built                               | `src/daemon/Loader.ts` `typecheck`, `Messages.effectGuide`                                                                                   | `test/unit/loader.test.ts`                               |
| LOAD-41 | built                               | `src/daemon/Loader.ts` `toWork`, `mapStack`, `run`                                                                                           | `test/daemon/loader.test.ts`                             |
| LOAD-48 | built                               | `src/daemon/Loader.ts` `bundle` (`hash` of the bundle text)                                                                                  | none                                                     |
| LOAD-49 | built                               | `src/daemon/Loader.ts` `bundle` (`absWorkingDir` is the tree, so paths are relative). Checked by hand: one source in two trees gave one hash | none                                                     |
| LOAD-53 | built, part held (`apply`)          | `src/daemon/Loader.ts` `check`                                                                                                               | `test/unit/loader.test.ts`                               |
| LOAD-66 | built                               | `src/daemon/Loader.ts` `run`                                                                                                                 | none                                                     |
| LOAD-68 | built                               | `src/Timings.ts` `pluginBuild`                                                                                                               | none                                                     |
| LOAD-72 | built, part held (`apply`)          | `src/daemon/Loader.ts` `discover`, `Messages.twoEntries`                                                                                     | none                                                     |
| LOAD-73 | built                               | `src/daemon/Loader.ts` `discover`, `run`, `Messages.notPlugin` (helper case)                                                                 | `test/daemon/loader.test.ts`                             |
| LOAD-76 | built                               | `src/daemon/Loader.ts` `compilerOptions` (`types: ["node"]`), `run`                                                                          | `test/unit/loader.test.ts`, `test/image/image.test.ts`   |
| LOAD-77 | built                               | `src/daemon/Loader.ts` `compilerOptions`                                                                                                     | `test/types/plugins.test.ts`                             |
| LOAD-78 | built                               | `src/daemon/Loader.ts` `compilerOptions` (`erasableSyntaxOnly`)                                                                              | none                                                     |
| LOAD-79 | built                               | `src/daemon/Loader.ts` `compilerOptions`; `typecheck` turns the TS2835 hint's `.js` into `.ts`                                               | none                                                     |
| LOAD-80 | built                               | `src/daemon/Loader.ts` `compilerOptions`, read by `typecheck`, `test/types/plugins.test.ts` and `test/image/image.test.ts`                   | `test/types/plugins.test.ts`, `test/image/image.test.ts` |
| LOAD-81 | built                               | `src/daemon/Loader.ts` `typecheck` (`include`)                                                                                               | `test/unit/loader.test.ts`                               |
| LOAD-85 | built                               | `src/daemon/Loader.ts` `register`, called from `src/daemon/Plugins.ts` `load` on the plugin's scope                                          | none                                                     |
| LOAD-86 | built                               | `src/daemon/Plugins.ts` `as` (`Loader.remap`)                                                                                                | `test/daemon/loader.test.ts`                             |
| LOAD-92 | built, part held (`apply`)          | `src/daemon/Loader.ts` `discover`, `Messages.pluginName`                                                                                     | none                                                     |
| LOAD-98 | built (new builder rule)            | `src/daemon/Loader.ts` `check`                                                                                                               | none                                                     |

## Repo and recovery (09)

| Rule   | Status                     | Where                              | Test                       |
| ------ | -------------------------- | ---------------------------------- | -------------------------- |
| REC-25 | built, part held (`apply`) | `src/daemon/Loader.ts` `check`     | `test/unit/loader.test.ts` |
| REC-27 | built                      | `src/daemon/Loader.ts` `typecheck` | `test/unit/loader.test.ts` |

## Self-edit skill (14)

| Rule    | Status | Where                                                                                          | Test                       |
| ------- | ------ | ---------------------------------------------------------------------------------------------- | -------------------------- |
| SELF-26 | built  | `src/daemon/RepoLinks.ts` `prepare`                                                            | `test/image/image.test.ts` |
| SELF-62 | built  | `src/Messages.ts` (`importable`, `topLevelAwait`, `notPlugin`, `buildTimedOut`, `bundledName`) | `test/unit/loader.test.ts` |
| SELF-63 | built  | `src/daemon/Loader.ts` `bundleError`                                                           | none                       |
| SELF-64 | built  | `src/daemon/Loader.ts` `typecheck`                                                             | `test/unit/loader.test.ts` |

## Failures, logs and status (16)

| Rule     | Status                   | Where                                                                   | Test                         |
| -------- | ------------------------ | ----------------------------------------------------------------------- | ---------------------------- |
| FAIL-289 | built                    | `src/daemon/RepoLinks.ts` `prepare`                                     | `test/daemon/loader.test.ts` |
| FAIL-344 | built (new builder rule) | `src/Status.ts`, `src/Rpcs.ts` `Report.skipped`, `src/daemon/Server.ts` | `test/daemon/loader.test.ts` |

## Testing (17)

| Rule    | Status | Where                                    | Test                                                     |
| ------- | ------ | ---------------------------------------- | -------------------------------------------------------- |
| TST-188 | built  | `src/daemon/Loader.ts` `compilerOptions` | `test/types/plugins.test.ts`, `test/image/image.test.ts` |
