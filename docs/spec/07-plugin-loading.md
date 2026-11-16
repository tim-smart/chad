# Runtime and plugin loading

This part covers the runtime chad runs on and the loader, which is the code in the daemon that turns a plugin's TypeScript files into a running instance. It says how a plugin is bundled, run, type-checked and given its imports, which plugin names and which files a check refuses, where the files being checked sit on the data volume, which plugins an apply rebuilds, and the order in which a new version takes over from an old one. It ends with the memory and timing measurements behind the design. It leans on 06-plugin-api.md for what a plugin exports, 08-apply-and-swap.md for what happens to work in flight while versions change, 09-repo-and-recovery.md for the git repo, revert, boot and safe mode, 10-cli.md for the commands, 01-image-and-volume.md for what the image ships, 12-skills-and-mcp.md for what clanka reads from the directories around the agent, 16-failures-logs-status.md for logs and notices, and 17-testing.md for the tests.

Terms used below. The host is the chad daemon process together with the packages in the image's `node_modules`. An apply is the `chad apply` command, which makes the files the agent edited in `repo/work/` the running version. A bundle is one plugin's code packed into a single file. An exported tree is a plain copy of the repo's files at one snapshot, written under `repo/versions/`. A swap is the step in which new plugin versions take over from old ones.

## Runtime

chad runs on Node. The loader prototype also ran unchanged on Bun 1.3.13, so the loader did not decide the runtime. clanka did. Its executor depends on `node:vm` and `worker_threads`, and its own CI covers Node 24.12 only. The evidence for Node 26 is real use. clanka 0.27.0 ran the agent session that built the loader prototype on Node 26.8.2, and the swap prototype ran real clanka in every session on Node 26.8.2.

- **LOAD-1** chad runs on Node 26, the current LTS line. The toolchain of the chad repo, which is the Node that a builder and CI run the code and the tests on, is Node 26 (see 17-testing.md). The base image that carries the same Node is IMG-1's rule and is tested under that id (see 01-image-and-volume.md).
- **LOAD-2** The SQLite driver is the runtime's built-in one, `@effect/sql-sqlite-node` on `node:sqlite` (see 02-storage.md).
- **LOAD-3** A change to a plugin takes effect only through a chad CLI command. chad has no file watcher.
- **LOAD-4** Plugin code runs on the daemon's main thread. A synchronous loop in a plugin freezes the whole daemon, and the loader does nothing to prevent it. The liveness probe `chad health` is the answer (see 01-image-and-volume.md).

## Where a plugin lives and what the loader expects

- **LOAD-5** A plugin is one entry file in the repo, either `plugins/<name>.ts` or `plugins/<name>/index.ts`. The file name without `.ts`, or the directory name, is the plugin's name.
- **LOAD-6** A plugin's entry file default-exports a value made with `Plugin.make` (see 06-plugin-api.md). The loader tests the default export with `Plugin.isPlugin` and refuses a file that exports a bare Layer, because a bare Layer passes the type-check.
- **LOAD-72** When both `plugins/<name>.ts` and `plugins/<name>/index.ts` exist for one name, `chad check` and `chad apply` fail with an error that names both files.
- **LOAD-73** Every `.ts` file directly in `plugins/` is a plugin's entry file, and a plugin keeps its helper files in a subdirectory. A helper file placed directly in `plugins/` fails the `Plugin.isPlugin` test of LOAD-6, and the error says what to do.

A plugin's name is written into the name of its key-value table (see 02-storage.md), so the name rule that `chad plugin new` applies to the name it is given (see 10-cli.md) holds for every plugin in the repo, whichever way its file got there.

- **LOAD-92** `chad check` and `chad apply` fail when the exported tree holds a plugin whose name has a character other than a lower-case letter, a digit or a hyphen. The name is the one LOAD-5 defines, so the rule covers a plugin kept as one file and a plugin kept as a directory.
- **LOAD-98** The check of plugin names, LOAD-72 and LOAD-92, runs first. A check or an apply that a name fails stops there, before `tsc`, with one error for each such name. The steps of LOAD-53 follow.
- **LOAD-93** At a boot a plugin under `repo/live` whose name breaks the rule of LOAD-92 is skipped, and the other plugins load. It is announced like any other skipped plugin, under the notice key `plugin-skipped:<name>` (see 09-repo-and-recovery.md for the boot, and 16-failures-logs-status.md for the notice, which quotes the name as it is written and cuts it).

A bundled plugin is one that ships inside the chad package in the image, such as cron. It is not a file in the repo, so the rules of this part about bundling, the bundle hash and `import()` do not cover it.

- **LOAD-74** The daemon imports each bundled plugin as part of the built chad package. A bundled plugin never goes through esbuild or the bundle loader.
- **LOAD-75** chad builds a bundled plugin's Layer through the same scope, the same 30 second deadline and the same swap code as a repo plugin's Layer.

## Bundling

Node can load a `.ts` file directly with `import()`, but a module loaded that way is never freed (see "Measurements" below). So chad does not import plugin files. It bundles each plugin and runs the bundle itself. The image carries esbuild and TypeScript 7 in its `node_modules` (see 01-image-and-volume.md). esbuild runs as a child process of the daemon, so its memory is separate from the daemon's and a bundler crash cannot take the daemon with it.

- **LOAD-7** chad bundles each plugin with esbuild into one CommonJS (CJS) file. The bundle holds the plugin's entry file and the local files it imports.
- **LOAD-8** A bundle is kept in memory and is never written to the volume. chad bundles in the daemon at each apply and again at each boot.
- **LOAD-9** esbuild leaves every package import in the bundle as a `require` call. Only the plugin's own files go into the bundle.
- **LOAD-10** Each build also produces a source map. chad uses it to turn a stack frame inside a bundle back into the source file, line and column it came from.
- **LOAD-11** The bundler is called through one function, so it can be replaced without touching the rest of the loader. rolldown did the same job in the prototype and is the fallback.

The loader as the prototype ran it (`app/host.ts`), with the two loaders that were not chosen removed:

```ts
import * as esbuild from "esbuild"
import * as crypto from "node:crypto"
import { createRequire, SourceMap } from "node:module"
import * as path from "node:path"
import * as vm from "node:vm"

const hostRequire = createRequire(import.meta.url)

interface Loaded { readonly module: any; readonly hash: string; readonly map?: SourceMap; readonly filename?: string }

// Only the plugin's own files go into the bundle. Every package import stays a require call,
// which the loader answers with the host's copy.
const bundleEsbuild = async (file: string, dir: string) => {
  const result = await esbuild.build({
    entryPoints: [file], absWorkingDir: dir, bundle: true, write: false, outdir: dir,
    format: "cjs", platform: "node", target: "node24", sourcemap: "external", logLevel: "silent",
    packages: "external"
  })
  return {
    code: result.outputFiles.find((f) => f.path.endsWith(".js"))!.text,
    map: JSON.parse(result.outputFiles.find((f) => f.path.endsWith(".map"))!.text)
  }
}

// file is the plugin's entry file inside the exported tree, dir is the exported tree.
const loadBundle = async (file: string, dir: string): Promise<Loaded> => {
  const built = await bundleEsbuild(file, dir) // adjusted: TIM-538 item 2 (esbuild only)
  const code = built.code
  const map = new SourceMap(built.map)
  const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 12)
  const filename = file.replace(/\.ts$/, ".bundle.cjs")
  const run = vm.compileFunction(code, ["require", "module", "exports"], { filename })
  const module = { exports: {} as any }
  const loaded = { module: module.exports, hash, map, filename }
  try {
    run(hostRequire, module, module.exports)
  } catch (error: any) {
    throw new Error(mapStack(String(error?.stack ?? error), loaded, dir).split("\n    at loadBundle")[0])
  }
  return { ...loaded, module: module.exports }
}

// Rewrites "bundle.cjs:line:col" frames to the source file they came from.
const mapStack = (text: string, loaded: Loaded | undefined, dir: string) => {
  if (!loaded?.map || !loaded.filename) return text
  const name = loaded.filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return text.replace(new RegExp(name + ":(\\d+):(\\d+)", "g"), (whole, line, column) => {
    const entry: any = loaded.map!.findEntry(Number(line) - 1, Number(column) - 1)
    if (!entry?.originalSource) return whole
    const source = entry.originalSource.startsWith("file:") ? new URL(entry.originalSource).pathname
      : path.resolve(dir, entry.originalSource)
    return source + ":" + (entry.originalLine + 1) + ":" + (entry.originalColumn + 1)
  })
}
```

## Running a bundle

- **LOAD-12** chad compiles a bundle with `vm.compileFunction`, with the parameters `require`, `module` and `exports`, and calls the result with the host's own `require` and a fresh `module` object. The plugin is the value the bundle leaves in `module.exports.default`.
- **LOAD-13** chad builds the plugin's Layer once, in a scope of its own. Closing that scope unloads the plugin.
- **LOAD-14** One plugin's Layer has 30 seconds to build. The daemon owns that deadline. Past it an apply fails and a boot skips the plugin.
- **LOAD-68** The 30 second deadline for a Layer build is a default of the `Timings` service, and the shipped binary has no setting that changes it (see 17-testing.md).
- **LOAD-15** The loader provides the host services a plugin's Layer may need (`Plugin.Services` in 06-plugin-api.md), including `DateTime.CurrentTimeZone`, the owner's timezone, and `PluginContext.owners`, the owner ids as `<platform>:<id>`. It reads the owner ids when the plugin loads.
- **LOAD-69** A warning or an error that a plugin logs while its Layer builds stays a log line and sends no notice, and `chad status` shows each plugin's count of warnings and errors since it loaded (see 16-failures-logs-status.md).

## How imports resolve

A plugin has no way to load a package of its own, so there is no second copy of anything to guard against. The loader hands the bundle the host's `require`, and that function answers every `require` call esbuild left in place.

- **LOAD-16** Every package import in a plugin is answered by the host's own `require`. chad installs no resolve hook.
- **LOAD-17** `effect`, `chad` and every other package a plugin imports come from the image as the host's single instances. `effect` is published as ES modules only, and Node's `require` returns the same instance the host got from `import`. A plugin's `Effect.gen` is the host's `Effect.gen`.
- **LOAD-18** The daemon's entry point runs as separate files and is not bundled, so the daemon never runs a bundled copy of `effect` (see 10-cli.md for the bundled CLI).
- **LOAD-19** The image's CI fails when `node_modules` holds more than one `effect` (see 01-image-and-volume.md).
- **LOAD-20** The packages a plugin is promised it can import are `chad`, `effect` and Node's built-in modules, and removing one of those is a breaking change to the plugin API. Any other direct dependency of chad resolves when a plugin imports it but is not promised, and the `self-edit` skill says so (see 06-plugin-api.md and 14-self-edit-skill.md).
- **LOAD-21** From the `chad` package a plugin can import exactly four modules, which are `chad`, `chad/Plugin`, `chad/Session` and `chad/Turns`. The package's `exports` lists those and nothing else, so `import "chad/daemon"` fails the type-check.
- **LOAD-22** A plugin has no npm dependencies of its own in v1. An import of a package the image does not ship fails the type-check with `TS2307`. chad rewrites that error so that it lists what can be imported.
- **LOAD-76** A plugin may import Node's built-in modules, such as `node:fs`. The type-check loads the Node types, and the host's `require` answers the import when the plugin runs.

## What a plugin file may not do

These limits follow from running a plugin as a CJS bundle. The bundled `self-edit` skill teaches them to the agent (see 14-self-edit-skill.md).

- **LOAD-23** A plugin cannot use top-level await. esbuild refuses to bundle it with an error that names the line, so `chad check` and `chad apply` fail. chad rewrites the error so that it says the fix.
- **LOAD-24** A plugin's `import.meta` is empty. A plugin therefore cannot find files that sit next to it.

## Type-checking

The `repo/node_modules` symlink serves the type-check, an editor and the agent's own tools. It plays no part when a plugin runs, because the host's `require` answers every import then.

- **LOAD-25** `chad apply` and `chad check` type-check the exported tree with `tsc`, from the TypeScript 7 the image carries, before any plugin is bundled or loaded. A type error blocks the apply. There is no flag to skip the check.
- **LOAD-26** `repo/node_modules` is a symlink to the image's `node_modules`, and `repo/package.json` says `"type": "module"`. Both sit one level above `work/` and outside git. Without that `package.json`, `tsc` treats plugin files as CommonJS and fails them with `TS1287`.
- **LOAD-27** `tsc`, an editor and the agent's own tools find `effect`, `chad` and the Node types by walking up from a file under `repo/work/` or `repo/versions/<tree>/` to `repo/node_modules`. The type-check loads one copy of `effect`, the image's.
- **LOAD-28** `chad` resolves from `repo/node_modules` through a link from the chad package to itself in the image's `node_modules`, so `import { Plugin } from "chad"` passes the type-check.
- **LOAD-29** chad writes the tsconfig for each check itself and keeps it out of the repo's files. No file in the repo can loosen the check.
- **LOAD-30** Type errors name `work/` paths, not paths in the exported tree, for example `work/plugins/dice.ts(23,30): error TS2322`.
- **LOAD-31** A failed type-check whose error is in a file under `plugins/` ends with one line that names effect's `AGENTS.md` (see 10-cli.md).
- **LOAD-77** The check runs with the compiler options in the tsconfig printed below.
- **LOAD-78** A plugin file that uses an enum, a namespace or a parameter property fails the type-check, because the options allow only syntax that can be erased.
- **LOAD-79** A relative import in a plugin names its file with the extension, as in `./label.ts`. A relative import with no extension fails the type-check.
- **LOAD-80** chad keeps these options in one place. The check, the image's test that type-checks a plugin from `repo/node_modules` and the type-check of the fixture plugins in CI all read them from there, so each of the three loads the Node types (see 01-image-and-volume.md and 17-testing.md).
- **LOAD-81** The check covers the files that match `plugins/**/*.ts` in the exported tree and no others. A TypeScript file that chad never runs, such as a script inside a skill, cannot fail an apply.

The tsconfig chad writes for each check. The prototype wrote it next to the exported tree and deleted it after the run:

```json
{
  "compilerOptions": {
    "target": "es2024", "lib": ["es2024"], "module": "nodenext", "moduleResolution": "nodenext",
    "strict": true, "noEmit": true, "skipLibCheck": true, "types": ["node"],
    "allowImportingTsExtensions": true, "erasableSyntaxOnly": true, "verbatimModuleSyntax": true
  },
  "include": ["<tree>/plugins/**/*.ts"]
}
```

The prototype ran it as `node_modules/.bin/tsc -p <config> --pretty false` with `repo/` as the working directory.

## The repo directory, exported trees and the live symlink

The daemon never loads from the directory the agent edits. An apply takes a snapshot of `work/`, writes it out as an exported tree, and checks and loads from that copy. `live` names the exported tree that is applied. Exporting a tree, in place of keeping a second checkout, has three reasons. A git worktree shares `.git` with `work/`, so the agent's own git commands could break it. A second clone needs a fetch on every apply. Either one changes files in place, so a boot during an apply could read half of each version.

```
repo/
  work/               the one git repo. The agent edits here.
  versions/<tree>/    an exported tree, named by its git tree id
  live                symlink to versions/<tree>, the applied tree
  node_modules        symlink to the image's node_modules
  package.json        says "type": "module"
  examples            symlink to the bundled plugins' source inside the chad package
```

- **LOAD-32** The editable files are one git repo at `repo/work/`. `repo/live` is a symlink to an exported tree. It is not a checkout, a worktree or a second clone.
- **LOAD-82** The branch checked out in `repo/work/` is named `main` (see 09-repo-and-recovery.md).
- **LOAD-33** An apply takes its snapshot with `git add -A` into a temporary index followed by `git write-tree`. The agent's index, HEAD and branch are untouched, and `.gitignore` is respected.
- **LOAD-34** The snapshot does not miss an edit. If chad copies git's index to start from, the copy keeps the mtime of the original. Otherwise the snapshot starts from an empty index. A copied index with a newer mtime switches off git's check for an edit made in the same clock tick as the last index write, and a same-size edit in that tick then looks unchanged.
- **LOAD-35** chad exports the snapshot's tree to `repo/versions/<tree>/` with `git checkout-index --prefix`, under a temporary name first (LOAD-83). The type-check, the bundling and the Layer builds all read from that directory.
- **LOAD-83** Every export of a tree, in an apply and at a boot, writes the files under a temporary name and renames the directory to `repo/versions/<tree>` once the export is complete. A kill during an export therefore never leaves a half-written directory under a tree's name for a boot to take as complete.
- **LOAD-36** On success chad commits the tree on the `applied` branch, with the previous applied commit as its parent. The applied history is one commit per apply.
- **LOAD-84** chad makes the applied commits with the git identity `chad` and `chad@localhost` (see 09-repo-and-recovery.md for where the identity is stored).
- **LOAD-37** On success chad repoints the `repo/live` symlink with a rename. A boot that reads `live` during an apply sees the old tree or the new one, never half of each.
- **LOAD-38** On success chad resets the branch in `work/` to the new commit. After an apply `git status` in `work/` is clean, and from then on `git diff` shows the draft. A commit the agent made itself between applies leaves the branch and stays only in the reflog.
- **LOAD-39** On success chad deletes the older exported trees as soon as the swap is done. One directory is left under `repo/versions/`.
- **LOAD-40** When a check or a build fails, chad deletes the newly exported tree and changes nothing else. `live`, the `applied` branch and `work/` stay as they were, and the running versions keep answering. Every check and every build comes before the commit. A failure from the commit on, such as a volume that fills, is covered in 09-repo-and-recovery.md.
- **LOAD-41** Error text from a check or a load is rewritten to `work/` paths. That covers type errors and stack frames, which chad maps back through the source map, for example `at connect (work/plugins/broken.ts:6:9)`.
- **LOAD-85** chad keeps the source map of each running plugin version for as long as that version runs.
- **LOAD-86** When a plugin fails after it loaded, in a tool handler or a hook, chad rewrites the stack frames inside its bundle to `work/` paths the same way as LOAD-41, both in the tool error the model reads and in the log.
- **LOAD-42** `versions/`, `live`, the `node_modules` link, `package.json` and `examples` are derived. chad creates them at boot when they are missing, and makes the `node_modules` link again when the image's path changed. The first boot after a restore rebuilds `versions/` and `live` from the head of the `applied` branch (see 09-repo-and-recovery.md).
- **LOAD-43** At boot chad replaces a link found at `repo/examples` or `repo/node_modules` without asking. Anything else at those paths is moved to `<name>.replaced-<timestamp>` and logged.
- **LOAD-44** `repo/examples` is a symlink to the bundled plugins' TypeScript source inside the chad package. chad creates it at every boot, so it shows the running image's source. Nothing loads from it. It is there for the agent to read.
- **LOAD-45** `git status` in `work/` shows neither `repo/node_modules` nor `repo/examples`. The daemon's user, uid 1000, cannot write through either link into the image.
- **LOAD-46** The daemon reads skills and `mcp.json` through `repo/live`. `live` points at a different directory after every apply and the older directories are deleted, so a path that was resolved through `live` before an apply names a directory that is gone after it.
- **LOAD-87** When chad hands out the path of a file under `live`, such as a skill's directory, it gives the path through `repo/live` and does not resolve the symlink. That path stays valid across applies (see 12-skills-and-mcp.md).
- **LOAD-47** An apply exports the whole tree every time, skills and persona included.

The git commands, all run with `repo/work/` as the working directory. The first three carry `GIT_INDEX_FILE=<temporary index>`:

```
git add -A
git write-tree                                        prints <tree>
git checkout-index -a --prefix=<repo>/versions/<temporary name>/
git commit-tree <tree> [-p <head of applied>] -m <message>    prints <commit>
git update-ref refs/heads/applied <commit>
git reset -q <commit>
```

Between `git checkout-index` and the type-check, chad renames the exported directory to `<repo>/versions/<tree>`.

How the prototype moved `live`:

```ts
const moveLive = (dir: string) => {
  const tmp = LIVE + ".next"
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(path.relative(REPO, dir), tmp)
  fs.renameSync(tmp, LIVE) // atomic: a boot sees the old version or the new one, never half
}
```

## Files the repo may not hold

clanka reads `AGENTS.md` files, and looks for skills under `.agents/skills` and `.kiro/skills`, in the directories around the agent's working directory, and it does so with no apply (see 12-skills-and-mcp.md for the fact and how far the read reaches). chad does not stop that read. It keeps such files out of every applied commit instead, because a skill kept there would be announced a second time beside the list of skills that chad itself passes to clanka. clanka reads from `repo/work/` as it is on disk and not from the exported tree, and `.gitignore` can keep a file on disk out of the export, so a check and an apply look in both places.

- **LOAD-94** `chad check` and `chad apply` look for a file named `AGENTS.md` and for a directory named `.agents` or `.kiro` in two places, and fail when either place holds one. The first place is the exported tree. The second is `repo/work/` as it is on disk. Both are searched at any depth, apart from the two directories LOAD-96 names.
- **LOAD-96** The look on disk of LOAD-94 finds a file or directory that `.gitignore` keeps out of the export. Neither look goes into a directory named `.git` or `node_modules`, at any depth, so an `AGENTS.md` that a package ships inside `node_modules` fails neither a check nor an apply, whether or not `node_modules` is in the export.
- **LOAD-95** The error of LOAD-94 names `skills/` and `persona.md`, which are where a skill and the persona go in the repo.
- **LOAD-97** A boot does not look for these names. When the tree it loads or `repo/work/` already holds an `AGENTS.md` file or an `.agents` or `.kiro` directory, as it can after a restore or after a file was written by hand, the boot starts and loads exactly as it would without it. It skips nothing on that account and raises no notice. One that is still in `repo/work/` fails the next `chad check` or `chad apply` under LOAD-94. No file in the repo can stop a boot (see 09-repo-and-recovery.md).

## Which plugins an apply rebuilds

The hash of a plugin's bundle is how chad knows whether the plugin's code changed. Because the bundle holds the entry file and every local file it imports, an edit to an imported file changes the hash of each plugin that imports it.

- **LOAD-48** chad takes a hash of each bundle. The hash covers the plugin's entry file and every local file it imports.
- **LOAD-49** The same source gives the same hash in every exported tree. The bundle's text does not depend on the directory it was built from.
- **LOAD-50** An apply rebuilds a plugin when its bundle hash differs from the running version's, or when its entry in `chad.json` differs from the applied one, compared before `${NAME}` is expanded (see 11-settings.md). Every other plugin is left running as the same instance and is not part of the swap.
- **LOAD-51** The loader can also rebuild a plugin whose bundle did not change. `chad plugin reload <name>`, a secret change, an owner change and a timezone change use that, since none of them changes a bundle. The new instance is built first. A plugin whose build fails keeps its old version while the plugins that built are swapped. The one exception is the removal of an owner, after which a plugin whose build fails is unloaded, so that it cannot keep answering the removed person (see 08-apply-and-swap.md and 10-cli.md).
- **LOAD-52** A plugin whose file is new in the tree is built and loaded. A plugin whose file was deleted, or whose `chad.json` entry says `"enabled": false`, is not loaded and its running version is unloaded in the swap (see 10-cli.md and 11-settings.md for what is kept).
- **LOAD-88** A bundled plugin has no bundle hash, because its code changes only with a new image. Of the two tests in LOAD-50, only the `chad.json` entry applies to it.

## Order of an apply and of a swap

An apply runs these steps in order:

1. Take the snapshot of `work/`.
2. Export the snapshot's tree.
3. Type-check the exported tree.
4. Bundle each plugin and build the Layer of each one that changed.
5. Run the trial `Agent.makeWith`.
6. Commit the tree on the `applied` branch.
7. Move `live`.
8. Reset the branch in `work/`.
9. Swap the plugin versions.
10. Delete the older exported trees.

`chad check` does everything up to the commit and throws the result away (see 10-cli.md). 10-cli.md also lists everything an apply fails on, which includes checks of `chad.json`, `mcp.json`, the skills and the tool descriptions that this part does not cover. Where in this order the check of plugin names (LOAD-92) and the check for files the repo may not hold (LOAD-94), with its look on disk, run is not decided (see Gaps).

Building a new version does not activate it. Activation is the moment chad starts routing work to the new version and lets its deferred work start. Building first is what lets a failed load keep the last good version. The cost is that anything a plugin starts while its Layer builds runs next to the old version until the old one is closed, which is why `Plugin.background` exists.

- **LOAD-53** The checks run in this order. First `tsc` runs on the exported tree. Then each plugin is bundled, and each plugin that changed gets the `Plugin.isPlugin` test and its Layer built. Last comes a trial `Agent.makeWith` with every plugin's tools, which exists because clanka dies on a tool name clash.
- **LOAD-54** A swap starts only after every new version in it has built. In an apply one failed check or build means nothing swaps. The new versions that did build are closed, and the old versions keep answering.
- **LOAD-55** The commit and the move of `live` come before the swap. A stop during the swap therefore leaves the new version for the next boot to load (see 08-apply-and-swap.md).
- **LOAD-70** An apply that succeeds and was run from a session posts one line in that session's thread, and an apply run from the owner's shell or an apply that fails posts nothing (see 16-failures-logs-status.md).
- **LOAD-91** An apply that is refused or that fails writes the `apply.failed` event to the log, with the stage it failed at and the error (see 16-failures-logs-status.md for the table of events).
- **LOAD-56** A swap builds the new version, then closes the old version's scope, then activates the new one. Between the build and the activation sit the gate, the 30 second drain deadline and the 10 second close deadline (see 08-apply-and-swap.md).
- **LOAD-57** `Plugin.background(effect)` returns a Layer like the other contribution functions. It forks the effect into the plugin's scope, and the fiber starts only at activation, which is after the previous version's scope has closed.
- **LOAD-58** A fiber that a plugin forks directly while its Layer builds runs next to the previous version's fibers until the previous version is closed. In the prototype such a fiber ticked four times beside the old one in a 150 ms window, and the `Plugin.background` fiber ticked zero times before activation.
- **LOAD-59** `Turns.start` called by a version that is not active yet waits for the activation, and so does every other function of `Turns` (see 06-plugin-api.md, which also says what ends such a call when it is made while the Layer is still building).
- **LOAD-60** The two versions' background work never overlaps unless old code ignores interruption. chad logs that case when the swap moves on and again when the old code ends. Both are log lines only, and chad sends no notice for them (see 16-failures-logs-status.md).

`Plugin.background` as the loader prototype declared it. 06-plugin-api.md holds the signature in its final form:

```ts
export declare const background: <E>(
  effect: Effect.Effect<unknown, E, Services | Scope.Scope>
) => Layer.Layer<never, never, Services>
```

The prototype's plugin that shows both kinds of fiber (`seed/plugins/ticker/index.ts`):

```ts
import { Plugin } from "chad"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { label } from "./label.ts"

export default Plugin.make(
  // Forked while the Layer builds, so it runs next to the old version until that one is closed.
  Layer.effectDiscard(Effect.gen(function*() {
    const context = yield* Plugin.PluginContext
    yield* Effect.forkScoped(
      context.log(`naive ${label}`).pipe(Effect.andThen(Effect.sleep("40 millis")), Effect.forever)
    )
  })),
  // Starts only after the old version has been closed.
  Plugin.background(Effect.gen(function*() {
    const context = yield* Plugin.PluginContext
    yield* context.log(`background ${label}`).pipe(Effect.andThen(Effect.sleep("40 millis")), Effect.forever)
  }))
)
```

What the prototype printed for each refused apply, after the path rewrite. The lines chad adds, such as "could not be loaded", are the prototype's own wording and are not decided (see Gaps):

```
work/plugins/dice.ts(23,30): error TS2322: Type 'Effect<number, never, never>' is not assignable to type 'Effect<string, AiError | AiErrorReason, never>'.

bare: the default export is not a Plugin. Wrap it in Plugin.make(...)

broken: the Layer failed to build
Error: sidecar refused the connection
    at connect (work/plugins/broken.ts:6:9)

broken: could not be loaded
SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
    at JSON.parse (<anonymous>)
    at work/plugins/broken.ts:2:38

clash: tool "bash" is already defined by chad

work/plugins/extra.ts(2,25): error TS2307: Cannot find module 'lodash' or its corresponding type declarations.

tla: could not be loaded
✘ [ERROR] Top-level await is currently not supported with the "cjs" output format

    plugins/tla.ts:5:15:
      5 │ const waited = await Promise.resolve(import.meta.url ?? "(import.me...
        ╵                ~~~~~
```

## Boot and stop

- **LOAD-61** A boot loads what `repo/live` points at through the same bundle loader, with no type-check.
- **LOAD-89** When `repo/live` and the head of the `applied` branch name different trees at a boot, for example after a kill between the commit and the rename, the head of `applied` wins. Before it loads anything, the boot makes `live` name the tree of that commit, exporting the tree by LOAD-83 if `repo/versions/` does not hold it (see 09-repo-and-recovery.md).
- **LOAD-62** At boot a plugin whose Layer fails to build, or whose tool name clashes, is skipped. The rest load. One notice to the owner names the skipped plugins, and a plugin that stays skipped over later boots is not announced again (see 09-repo-and-recovery.md for the boot, and 16-failures-logs-status.md for the keyed notice rule and the wording).
- **LOAD-63** Safe mode loads nothing from the repo through this loader. Bundled plugins stay on, except a bundled plugin whose entry in the applied `chad.json` says `"enabled": false`, which stays off (see 09-repo-and-recovery.md and 11-settings.md).
- **LOAD-90** A boot in safe mode never starts esbuild, so safe mode works when esbuild does not.
- **LOAD-64** On a graceful stop chad runs the hooks queued off the reply path, each inside its own budget and all of them inside the part of the stop budget that is given to hooks, before it closes the plugins' scopes, and it closes the plugins' scopes before the MCP layer. A plugin that the stop catches between its close and its activation in a swap drops its queued hooks with a log line (see 01-image-and-volume.md for the stop budget and 08-apply-and-swap.md for a stop during a swap).
- **LOAD-65** A session's queued `Compacted` hooks finish before that session's next turn starts (see 03-sessions-and-turns.md).

## Measurements

These are the findings behind the choice of loader. They ran on Linux x64 and ext4, with effect 4.1.4, esbuild 0.28.2, rolldown 1.3.2 and TypeScript 7.0.2, outside Docker.

- **LOAD-66** chad never loads a plugin with `import()`. Node's ES module cache cannot be emptied, so a plugin loaded that way is never freed.
- **LOAD-67** After a plugin is rebuilt and its old version closed, the old bundle's module is garbage collected.
- **LOAD-71** The tests of this part's rules, among them the scenario that asserts one copy of `chad` and of `effect` in the running daemon, and the check that the `chad` package exports exactly its four modules, are in 17-testing.md.

Memory after many applies. Each apply edits two plugins, one of which has 30 tools:

| Loader | Runtime | Applies | Heap before | Heap after | Old modules collected | Exported trees left on disk |
| --- | --- | --- | --- | --- | --- | --- |
| `import()` of the `.ts` file | Node 24.22.2 | 300 | 29.6 MB | 71.4 MB | 0 of 900 | 305 |
| `import()` of the `.ts` file | Node 24.22.2 | 900 | 29.6 MB | 152.9 MB | 0 of 2,700 | 904 |
| `import()` of the `.ts` file | Node 26.8.2 | 300 | 30.5 MB | 71.2 MB | 0 of 900 | 305 |
| esbuild bundle | Node 24.22.2 | 300 | 29.7 MB | 43.6 MB | 600 of 600 | 1 |
| esbuild bundle | Node 24.22.2 | 900 | 29.7 MB | 44.6 MB | 1,800 of 1,800 | 1 |
| esbuild bundle | Node 26.8.2 | 900 | 30.7 MB | 36.5 MB | 1,800 of 1,800 | 1 |
| rolldown bundle | Node 26.8.2 | 900 | 30.6 MB | 36.7 MB | 1,800 of 1,800 | 1 |
| esbuild bundle | Bun 1.3.13 | 300 | 14.6 MB | 12.3 MB | 600 of 600 | 1 |

The `import()` loader grew by about 47 KB per plugin reload and never stopped. It also had to reload every plugin on every apply, because the exported tree's directory is part of each module's identity, and it could not delete old exported trees. Node 26 leaks the same way, at 46 KB per plugin reload.

Resident memory of the daemon after 900 applies on Node 26.8.2 was 203 MB with esbuild, plus 23 MB in esbuild's child process, and 386 MB with rolldown, which runs inside the daemon as a native addon. esbuild's native binary is 11 MB in the image and rolldown's is 21 MB.

Time per apply, median, four plugins:

| Step | Node 24.22.2 | Node 26.8.2 |
| --- | --- | --- |
| Snapshot and export | 11 ms | 13.4 ms |
| `tsc` | 215 ms | 225 ms |
| Bundle and build | 10 ms | 11.4 ms |
| Commit and swap | 14 ms | 17.6 ms |

An apply takes about a quarter of a second, most of it `tsc`. The first bundle in a process takes about 300 ms while esbuild starts. TypeScript 7 checks two small files that import `effect` in 0.13 s with 107 MB of memory, where TypeScript 5.9.3 and 6.0.3 took 0.95 s and 326 MB. In the image, `tsc` and esbuild were each run by hand from `repo/node_modules` on a plugin that imports `chad` and `effect`, on amd64 and under emulation on arm64. The loader as a whole was not run in a container.

Other loading approaches that were measured and not chosen:

| Approach | Result |
| --- | --- |
| Node's own type stripping, with no build step | A `.ts` file outside the app directory loads. It rejects enums, namespaces, parameter properties and `.tsx`, needs `.ts` in relative imports and ignores tsconfig `paths`. Every way of loading the file again leaks, as the next rows show. |
| `import(url + "?v=" + n)` | The entry file is evaluated again, an edited file it imports stays stale, and old module graphs are never freed. 300 reloads of a module holding 1 MB grew the heap from 4 MB to 297 MB. |
| A `module.registerHooks` resolve hook that adds a generation to plugin URLs | The entry file and its imports are evaluated again with one `effect`. It uses the same cache, so the same leak is expected. That was not measured. |
| esbuild to one ES module file per reload | Imports are fresh. It leaks the same way. |
| `vm.SourceTextModule` | It needs `--experimental-vm-modules`, and old modules were not freed. |
| jiti 2.7.0 with its caches off | It shares the host's instance, imports are fresh and 299 of 300 old modules were freed. It does not give chad the hash, the source map or control over what stays outside the bundle. |
| tsx 4.23.15 `tsImport` | It loaded a second copy of the shared package, missed the edit to an imported file and leaked. |
| A worker per plugin | Not tested. Each worker has its own module graph, so plugins could not share the host's Effect services. |
| Bun 1.3.13 as the runtime | It ran the bundle loader unchanged and freed old modules. It has no `registerHooks`. It was not chosen because clanka is tested on Node only. |

No run checked a volume on a filesystem other than ext4, or a repo with many files, which matters because a snapshot exports the whole tree. Inside the loader prototype a comparison of tool names stood in for the trial `Agent.makeWith`.

## Gaps

- **LOAD-G4** [builder] Where chad writes the tsconfig and the temporary index. The prototype used `repo/versions/<tree>.tsconfig.json` and `repo/.snapshot-index`. Closest is TIM-538 items 6 and 8.
- **LOAD-G5** [builder] The hash function and its length. The prototype used SHA-256 of the bundle text cut to 12 hex characters, and the swap prototype cut it to 8. Closest is TIM-538 item 3.
- **LOAD-G6** [builder] The esbuild `target`. The prototype passed `node24` on both Node versions. Closest is TIM-538 items 1 and 2.
- **LOAD-G7** [builder] How a rebuild without a code change gets its code. The loader prototype did not build the reload by name. The swap prototype ran the bundle text it kept in memory from the running version. Whether chad does that or bundles again from `live` is undecided. Closest are TIM-538 item 3 and TIM-552.
- **LOAD-G10** [builder] The exact wording of the load errors (a default export that is not a Plugin, a bundle that could not be loaded, a Layer that failed to build) and of the rewritten top-level await and missing module errors. The tickets decide that the last two are rewritten and not what they say. Closest is TIM-549 item 20.
- **LOAD-G12** [builder] Whether a boot removes an exported tree left behind by a daemon that was killed during a check. The prototype removes every other tree at the next successful apply. Closest is TIM-538 item 6.
- **LOAD-G16** [builder] The values of the stage that the `apply.failed` event carries (LOAD-91). The numbered steps of an apply in this part are the closest list. Closest is TIM-559 round 2 R4.
- **LOAD-G17** [builder] Where in the order of LOAD-53 the check of plugin names (LOAD-92) and the check for files the repo may not hold (LOAD-94) run, the second with its look on disk in `repo/work/`, and the wording of their two errors beyond what LOAD-95 fixes. That wording includes whether the error of LOAD-94 gives the path of each file it found, which `git status` does not show for a file that `.gitignore` covers. Closest is TIM-559 round 3 A1 and A2 and TIM-559 round 4 item 7.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| LOAD-1 | TIM-538 item 1, TIM-541 item 1; TIM-559 cold read | Tim | run |  | `rule` | `repo` |
| LOAD-2 | TIM-536 item 4, with TIM-538 item 1 | Tim | run |  | `rule` | `harness` |
| LOAD-3 | Map, "Agreed at charting" | charting | not run |  | `rule` | `apply` |
| LOAD-4 | TIM-534, "How well each is supported", restated in TIM-538 | Tim | read |  | `fact` | `loader` |
| LOAD-5 | TIM-542 item 11 | Tim | run |  | `rule` | `loader` |
| LOAD-6 | TIM-530 resolution, TIM-534 item 4, TIM-538 | Tim | run |  | `rule` | `loader` |
| LOAD-7 | TIM-538 item 2 | Tim | run |  | `rule` | `loader` |
| LOAD-8 | TIM-538 item 2, TIM-541 | Tim | run |  | `rule` | `loader` |
| LOAD-9 | TIM-538 item 4 | Tim | run |  | `rule` | `loader` |
| LOAD-10 | TIM-538 items 2 and 6 | Tim | run |  | `rule` | `loader` |
| LOAD-11 | TIM-538 item 2 | Tim | run |  | `rule` | `loader` |
| LOAD-12 | TIM-538 items 2 and 4 | Tim | run |  | `rule` | `loader` |
| LOAD-13 | TIM-530 resolution | Tim | run |  | `rule` | `loader` |
| LOAD-14 | TIM-542 item 6 | Tim | not run |  | `rule` | `loader` |
| LOAD-15 | TIM-539, as recorded on TIM-538 | Tim | not run |  | `rule` | `plugin-api` |
| LOAD-16 | TIM-538 item 4 | Tim | run |  | `rule` | `loader` |
| LOAD-17 | TIM-538 item 4 | Tim | run |  | `rule` | `loader` |
| LOAD-18 | TIM-550 item 12 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| LOAD-19 | TIM-541 item 21 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| LOAD-20 | TIM-559 ruling on API-G12, which narrows TIM-541 item 22 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-21 | TIM-553 item 3 | Architect (Tim has not read) | run | TIM-553 | `rule` | `plugin-api` |
| LOAD-22 | TIM-538 item 5, amended by TIM-549 item 20 | Tim, the rewritten error Architect (Tim has not read) | run, the rewritten error not run | TIM-549 | `rule` | `loader` |
| LOAD-23 | TIM-538 item 2, amended by TIM-549 item 20 | Tim, the rewritten error Architect (Tim has not read) | run, the rewritten error not run | TIM-549 | `rule` | `loader` |
| LOAD-24 | TIM-538 item 2 | Tim | run |  | `fact` | `loader` |
| LOAD-25 | TIM-534 item 4, TIM-538 item 6, TIM-541 item 2 | Tim | run |  | `rule` | `loader` |
| LOAD-26 | TIM-538 item 8, TIM-529 report section 5 | Tim | run |  | `rule` | `loader` |
| LOAD-27 | TIM-538 item 8, TIM-553 | Tim | run |  | `rule` | `loader` |
| LOAD-28 | TIM-541 item 22, amended by TIM-553 item 3 | Architect (Tim has not read) | run |  | `rule` | `loader` |
| LOAD-29 | TIM-538 item 8 | Tim | run |  | `rule` | `loader` |
| LOAD-30 | TIM-534 item 3, TIM-538 item 6 | Tim | run |  | `rule` | `loader` |
| LOAD-31 | TIM-549 item 3 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-32 | TIM-538 item 6, which amends TIM-534 item 3 | Tim | run |  | `rule` | `apply` |
| LOAD-33 | TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| LOAD-34 | TIM-538 item 7 | Tim | run |  | `rule` | `apply` |
| LOAD-35 | TIM-538 item 6, the temporary name TIM-559 ruling on LOAD-G11 | Tim, the temporary name Architect (Tim has not read) | run, the temporary name not run | TIM-559 | `rule` | `apply` |
| LOAD-36 | TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| LOAD-37 | TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| LOAD-38 | TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| LOAD-39 | TIM-538 items 2 and 6 | Tim | run |  | `rule` | `apply` |
| LOAD-40 | TIM-538 item 6, TIM-531 item 5, the pointer to a failure from the commit on TIM-559 ruling on REC-G20 | Tim, the pointer Architect (Tim has not read) | run |  | `rule` | `apply` |
| LOAD-41 | TIM-534 item 3, TIM-538 item 6 | Tim | run |  | `rule` | `loader` |
| LOAD-42 | TIM-538, as recorded on TIM-541, and the follow-up on TIM-542, point 2 | Tim, the restore rule Architect (Tim has not read) | run for the links, not run for a restore |  | `rule` | `apply` |
| LOAD-43 | TIM-553 item 9 | Architect (Tim has not read) | run |  | `rule` | `apply` |
| LOAD-44 | TIM-538, changed by TIM-549 | Tim | run |  | `rule` | `apply` |
| LOAD-45 | TIM-553 | Architect (Tim has not read) | run |  | `rule` | `apply` |
| LOAD-46 | TIM-538, as recorded on TIM-537 | Tim | not run |  | `rule` | `skills-mcp` |
| LOAD-47 | TIM-538 | Tim | run |  | `rule` | `apply` |
| LOAD-48 | TIM-538 item 3 | Tim | run |  | `rule` | `loader` |
| LOAD-49 | TIM-538 item 3 | Tim | run |  | `rule` | `loader` |
| LOAD-50 | TIM-538 item 3, TIM-542 item 10, TIM-548 item 13 | Tim, the settings comparison Architect (Tim has not read) | run | TIM-548 | `rule` | `apply` |
| LOAD-51 | TIM-538 item 3, TIM-542 items 10, 14, 16 and 17, amended by TIM-547 item 14 | Tim, the unloading after an owner is removed Architect (Tim has not read) | run, a secret change and the removal of an owner not run | TIM-547 | `rule` | `apply` |
| LOAD-52 | TIM-542 item 12, TIM-548 item 7 | Tim, the off plugin Architect (Tim has not read) | run | TIM-548 | `rule` | `apply` |
| LOAD-53 | TIM-534 item 4, TIM-531 item 5 | Tim | run, with a stand-in for the trial |  | `rule` | `loader` |
| LOAD-54 | TIM-531 item 5, TIM-547 item 2 | Tim, the swap rule Architect (Tim has not read) | run |  | `rule` | `apply` |
| LOAD-55 | TIM-538 item 6, TIM-547 item 15 | Tim, the stop rule Architect (Tim has not read) | run |  | `rule` | `apply` |
| LOAD-56 | TIM-538 item 9, amended by TIM-547 items 3 to 5 | Tim, the deadlines Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| LOAD-57 | TIM-538 item 9 | Tim | run |  | `rule` | `apply` |
| LOAD-58 | TIM-538 item 9 | Tim | run |  | `rule` | `apply` |
| LOAD-59 | TIM-538 item 9, the other functions TIM-559 round 3 API-G15 | Tim, the other functions Architect (Tim has not read) | run, the other functions not run | TIM-559 | `rule` | `apply` |
| LOAD-60 | TIM-538, changed by TIM-552, amended by TIM-557 item 41 | Tim, the no notice rule Architect (Tim has not read) | run, the no notice rule not run |  | `rule` | `apply` |
| LOAD-61 | TIM-538 item 10, TIM-534 item 5 | Tim | run |  | `rule` | `apply` |
| LOAD-62 | TIM-534 item 5, amended by TIM-557 items 36 and 40 | Tim, the notice Architect (Tim has not read) | not run | TIM-557 | `rule` | `apply` |
| LOAD-63 | TIM-534 item 6, amended by TIM-548 item 9 | Tim, the bundled plugin that is off Architect (Tim has not read) | not run | TIM-548 | `rule` | `apply` |
| LOAD-64 | TIM-539, as recorded on TIM-538, amended by TIM-541 item 25, TIM-547 item 15 and TIM-553 item 8 | Tim, the stop budget, the hooks dropped during a swap and the MCP order Architect (Tim has not read) | not run | TIM-541, TIM-547, TIM-553 | `rule` | `plugin-api` |
| LOAD-65 | TIM-539, as recorded on TIM-538 | Tim | not run |  | `rule` | `plugin-api` |
| LOAD-66 | TIM-538 item 2, TIM-529 report section 3 | Tim | run |  | `rule` | `loader` |
| LOAD-67 | TIM-538 item 2, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Tim | run |  | `rule` | `apply` |
| LOAD-68 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-69 | TIM-557 item 28 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| LOAD-70 | TIM-557 item 39, which defines the notice of TIM-550 item 11 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-71 | TIM-558 items 7, 19 and 42, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| LOAD-72 | TIM-559 ruling on LOAD-G9 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-73 | TIM-559 ruling on LOAD-G9, with the ruling on API-G2 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-74 | TIM-559 ruling on LOAD-G8 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| LOAD-75 | TIM-559 ruling on LOAD-G8 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-76 | TIM-559 ruling on LOAD-G3 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-77 | TIM-559 ruling on LOAD-G1 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-78 | TIM-559 ruling on LOAD-G1 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-79 | TIM-559 ruling on LOAD-G1 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-80 | TIM-559 ruling on LOAD-G1 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-81 | TIM-559 ruling on LOAD-G2 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-82 | TIM-559 ruling on LOAD-G15 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-83 | TIM-559 ruling on LOAD-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| LOAD-84 | TIM-559 ruling on LOAD-G15 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-85 | TIM-559 ruling on LOAD-G13 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-86 | TIM-559 ruling on LOAD-G13 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| LOAD-87 | TIM-559 ruling on LOAD-G14 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| LOAD-88 | TIM-559 ruling on LOAD-G8 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| LOAD-89 | TIM-559 ruling on LOAD-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| LOAD-90 | TIM-559 ruling on LOAD-G8 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| LOAD-91 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-92 | TIM-559 round 3 A2, which widens TIM-542 item 11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `loader` |
| LOAD-93 | TIM-559 round 3 A2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| LOAD-94 | TIM-559 round 3 A1, TIM-559 round 4 item 7 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-95 | TIM-559 round 3 A1 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-96 | TIM-559 round 4 item 7 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-97 | TIM-559 round 4 item 8 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| LOAD-98 | Build, stage 3 | Builder (Tim has not read) | run |  | `rule` | `loader` |
