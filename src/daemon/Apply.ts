/**
 * The commands that change what is loaded from the repo: `chad apply`, `chad check`, `chad revert`, `chad safe` and
 * `chad plugin reload`, `chad timezone`, which reloads every plugin, and `chad plugin purge`, which drops the data of a
 * plugin that is gone. Each runs alone through the daemon's one queue. An apply checks and builds everything before
 * its commit, so a failure changes nothing, and from its commit on it runs in a fiber of the daemon's scope that the
 * client cannot interrupt.
 */
import { join } from "node:path"
import { Cause, Effect, Fiber, FileSystem, Path, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import * as Errno from "../Errno.ts"
import * as McpFile from "../McpFile.ts"
import * as Messages from "../Messages.ts"
import * as Repo from "../Repo.ts"
import * as SafeMode from "../SafeMode.ts"
import * as Secrets from "../Secrets.ts"
import * as Settings from "../Settings.ts"
import * as Skills from "../Skills.ts"
import * as Timezone from "../Timezone.ts"
import * as Loader from "./Loader.ts"
import * as Logger from "./Logger.ts"
import * as Mcp from "./Mcp.ts"
import type * as Notices from "./Notices.ts"
import * as Packages from "./Packages.ts"
import * as Persona from "./Persona.ts"
import * as PluginSettings from "./PluginSettings.ts"
import type * as Plugins from "./Plugins.ts"
import * as Prettier from "./Prettier.ts"
import * as Queue from "./Queue.ts"

/** What a command prints and its exit code. */
export interface Output {
  readonly stdout: ReadonlyArray<string>
  readonly stderr: ReadonlyArray<string>
  readonly code: 0 | 1
}

/**
 * What a command gives the queue. `mcp` asks for an MCP rebuild once the queue is released, whose lines follow what
 * the command printed.
 */
/** A command's output, and the wait for the MCP rebuild it started, which the output's lines end with. */
type Performed = Output & {
  readonly mcp?:
    Effect.Effect<ReadonlyArray<Messages.McpServerState>> | undefined
}

const done = (...stdout: ReadonlyArray<string>): Output => ({
  stdout,
  stderr: [],
  code: 0,
})
const failed = (...stderr: ReadonlyArray<string>): Output => ({
  stdout: [],
  stderr,
  code: 1,
})

/** The most errors a failed check prints before it counts the rest. */
const shown = 20

/** Who ran a command: the session from `CHAD_SESSION`, or nothing for the owner's shell. */
export interface Caller {
  readonly session: string | undefined
  /** Whether it was typed in chat, as `/safe` is, whose own output is already in the thread. */
  readonly chat?: boolean
}

/** The requests of the commands, as the CLI sends them. */
export type Request =
  | { readonly _tag: "Apply"; readonly message: string }
  | { readonly _tag: "Check" }
  | { readonly _tag: "Revert"; readonly commit: string | undefined }
  | { readonly _tag: "Safe"; readonly to: "on" | "off" | undefined }
  | { readonly _tag: "Reload"; readonly name: string }
  | { readonly _tag: "Timezone"; readonly zone: string }
  | {
      readonly _tag: "SecretSet"
      readonly name: string
      readonly value: string
      readonly note: string | undefined
    }
  | { readonly _tag: "SecretRm"; readonly name: string }
  | { readonly _tag: "Purge"; readonly name: string }
  | { readonly _tag: "McpRestart" }
  | { readonly _tag: "McpLoginStart"; readonly server: string }
  | {
      readonly _tag: "McpLoginFinish"
      readonly server: string
      readonly address: string
    }
  | { readonly _tag: "McpLogout"; readonly server: string }

export interface Commands {
  /**
   * Runs a command in the queue. `waiting` is told what it waits on when the queue is busy, and `print` gets
   * what a command prints before it ends, which is otherwise put before the rest of what it prints.
   */
  readonly run: (
    request: Request,
    caller: Caller,
    waiting: (line: string) => Effect.Effect<void>,
    print?: (lines: ReadonlyArray<string>) => Effect.Effect<void>,
  ) => Effect.Effect<Output>
  /** Whether safe mode is on now, and what turned it on. */
  readonly safe: () => SafeMode.State
  /**
   * Builds every loaded plugin again after an owner change, which plugins read as `PluginContext.owners`, and swaps
   * them. It runs inside the queue the owner change holds. With an owner removed, one that fails is unloaded.
   */
  readonly owners: (removed: boolean) => Effect.Effect<void>
  /** The persona of the applied tree, which a session takes when its Agent is built. */
  readonly persona: () => string
  /** The skills a session's Agent is built with: the applied tree's and the bundled ones, these alone in safe mode. */
  readonly skills: () => ReadonlyArray<Skills.Provided>
  /** The applied tree's skills that hide a bundled one, none in safe mode, which `chad status` marks. */
  readonly hiding: () => ReadonlyArray<string>
  /**
   * The plugins that are off, the applied `chad.json`'s and the bundled ones that are off by default, which
   * `chad status` and `chad plugin purge` read.
   */
  readonly off: () => ReadonlySet<string>
  /** The plugins whose settings in the applied `chad.json` name a secret, less those that are off. */
  readonly users: (secret: string) => ReadonlyArray<string>
  /**
   * Builds the named plugins again through the swap path and swaps those that built, a plugin a boot skipped included.
   * One that fails keeps its running version, marked with `kept`, and a skipped one whose module cannot be loaded is a
   * failure too. A name that is off, unknown or from the repo in safe mode is left out. It runs
   * inside the queue the caller holds.
   */
  readonly rebuild: (
    names: ReadonlyArray<string>,
    kept: NonNullable<Plugins.Plan["kept"]>,
  ) => Effect.Effect<{
    readonly swapped: ReadonlyArray<string>
    readonly failed: ReadonlyArray<{
      readonly name: string
      readonly error: string
    }>
  }>
}

/** Why a reload has no entry for a plugin, and the load error of a module in `live` that could not be loaded. */
interface NoEntry {
  readonly refused: string
  readonly unloadable?: string
}

type Services =
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path

export const make = Effect.fnUntraced(function* (options: {
  readonly repo: string
  readonly data: string
  /** Whether `CHAD_SAFE_MODE=1` is set for the daemon. */
  readonly forced: boolean
  /** The safe mode the boot found. */
  readonly initial: SafeMode.State
  readonly plugins: Plugins.Plugins["Service"]
  /** The installs of the trees' npm packages. */
  readonly packages: Packages.Packages
  /** The MCP layer, which an apply that changed `mcp.json`, a secret it names, `chad safe` and `chad mcp restart` rebuild. */
  readonly mcp: Mcp.Mcp
  /** The bundled plugins, by name, which a repo plugin may not share and which `chad plugin reload` builds again. */
  readonly bundled: ReadonlyArray<Plugins.Entry>
  /** The applied `chad.json` as the boot read it. */
  readonly settings: Settings.File
  /** The applied tree's persona as the boot read it. */
  readonly persona: string
  /** The applied tree's skills as the boot found them, and the bundled ones with their directory. */
  readonly skills: {
    readonly repo: Skills.Found
    readonly bundled: Skills.Found
    readonly bundledDirectory: string
  }
  /**
   * Drops a plugin's key-value table, and gives the number of keys it held, or nothing when there was no table.
   */
  readonly drop: (name: string) => Effect.Effect<number | undefined>
  /**
   * The timers of each plugin, with how many are overdue, which an apply reads to say what a plugin it loads fires and
   * what one it unloads holds.
   */
  readonly timers: Effect.Effect<
    ReadonlyArray<{
      readonly plugin: string
      readonly count: number
      readonly overdue: number
    }>
  >
  /** Deletes a plugin's timers and gives how many there were. */
  readonly purgeTimers: (name: string) => Effect.Effect<number>
  /** The notices, of which an apply clears the two about `chad.json` once the file it applied passed its checks. */
  readonly notices: Notices.Notices["Service"]
  readonly queue: Queue.Queue
  /** The daemon's scope, which an apply's steps from the commit on and a session's line run in. */
  readonly scope: Scope.Scope
  /** Takes the owner's timezone that `chad timezone` stored, before the plugins are built with it. */
  readonly zoned: (zone: string) => void
  /** Posts one line of subtext in a session's thread. */
  readonly announce: (
    session: string,
    line: string,
  ) => Effect.Effect<void, unknown>
}) {
  const context = yield* Effect.context<Services>()
  const fs = yield* FileSystem.FileSystem
  const { repo, plugins } = options
  const { work, live } = Repo.paths(repo)
  const bundledNames: ReadonlySet<string> = new Set(
    options.bundled.map(({ name }) => name),
  )
  let safe = options.initial
  /** The applied `chad.json`, which an apply or a revert replaces at its commit. */
  let applied = options.settings
  /** The applied tree's persona, which an apply or a revert replaces before its swap bumps the generation. */
  let persona = options.persona
  /** The applied tree's skills, which an apply or a revert replaces before its swap bumps the generation. */
  let skills = options.skills.repo
  /** The repo skills whose skipped notice holds, which the next apply clears, as its tree has none. */
  let skipped = new Set(skills.bad.map(({ name }) => name))
  const guide = Messages.effectGuide(
    join(repo, "node_modules/effect/AGENTS.md"),
  )

  /** The errors of a failed check: the first 20, a count of the rest, and the line about effect's guide once. */
  const errorLines = (errors: ReadonlyArray<string>) => {
    const lines = errors.flatMap((error) =>
      error.startsWith("work/") ? error.split("\n") : [error],
    )
    const named = lines.includes(guide)
    const rest = lines.filter((line) => line !== guide)
    return [
      ...rest.slice(0, shown),
      ...(rest.length > shown
        ? [Messages.moreErrors(rest.length - shown)]
        : []),
      ...(named ? [guide] : []),
    ]
  }

  /** A line in the session's thread, forked into the daemon's scope and not waited for. */
  const announce = (caller: Caller, line: string) =>
    caller.session === undefined || caller.chat === true
      ? Effect.void
      : options.announce(caller.session, line).pipe(
          Effect.catchCause((cause) =>
            Logger.event(
              "command.ran",
              "A command's line in its session could not be posted",
              {
                session: caller.session,
                cause: Messages.firstLine(Cause.pretty(cause)),
              },
            ),
          ),
          Effect.forkIn(options.scope),
          Effect.asVoid,
        )

  /**
   * Runs work that has to finish once it begins, on a fiber of the daemon's scope. A client that goes away does not cut
   * it, and a stop still does, since the forked fiber is interruptible even when its caller is not.
   */
  const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.forkIn(effect, options.scope).pipe(
      Effect.flatMap((fiber) => Effect.uninterruptible(Fiber.join(fiber))),
    )

  /**
   * Starts the MCP rebuild a change needs from inside the work that made it, which a client that goes away does not
   * cut, so the change is never left without its rebuild. The rebuild runs in the MCP service's scope and holds no
   * queue.
   */
  const rebuildIf = (needed: boolean) =>
    needed ? options.mcp.rebuild : Effect.succeed(undefined)

  /**
   * Makes the packages of the tree `live` names ready before it loads, and gives why they are not when they are not, so
   * a plugin that imports one is skipped with the reason and the others load, as at a boot.
   */
  const readyLive = (tree: string) =>
    options.packages.ready(tree).pipe(
      Effect.as(undefined),
      Effect.catchTag("PackagesError", (error) =>
        Effect.succeed(error.message),
      ),
    )

  const refused = (stage: string, errors: ReadonlyArray<string>) =>
    Logger.event("apply.failed", "An apply was refused", {
      stage,
      error: errors.join("\n").slice(0, 4000),
    }).pipe(Effect.as(failed(...errorLines(errors))))

  /** Every repo plugin of a tree, checked and run, before any Layer is built. */
  const checkTree = (directory: string) =>
    Effect.gen(function* () {
      const found = [
        ...(yield* Loader.instructions(directory)),
        ...(yield* Loader.instructions(work)),
      ]
      if (found.length > 0) {
        return {
          stage: "names",
          errors: [Messages.instructionsRefused([...new Set(found)])],
          loaded: [],
          skills: Skills.none,
        }
      }
      const { errors, loaded } = yield* Loader.check(
        repo,
        directory,
        bundledNames,
      )
      // A malformed skill fails the check as a plugin does.
      const checked = yield* Skills.check(directory)
      return {
        stage: "check",
        errors: [...errors, ...checked.errors],
        loaded,
        skills: checked.found,
      }
    })

  /**
   * What to build and what to unload so that the running plugins are `desired`. A running plugin is built again when
   * its bundle hash or its settings before expansion differ from the running version's, and `retry` says whether one
   * that is not running is built. Every running or skipped plugin that is not desired is unloaded: a repo plugin that
   * is gone and a plugin that is off.
   */
  const planFor = (
    desired: ReadonlyArray<Plugins.Entry>,
    retry: (entry: Plugins.Entry) => boolean,
  ) => {
    const running = new Map(
      plugins.versions().map((version) => [version.name, version]),
    )
    const names = new Set(desired.map(({ name }) => name))
    const build = desired.filter((entry) => {
      const version = running.get(entry.name)
      return version === undefined
        ? retry(entry)
        : version.hash !== entry.bundle?.hash ||
            !Settings.same(version.entry.settings, entry.settings)
    })
    const remove = [
      ...new Set(
        [...plugins.versions(), ...plugins.skipped()].map(({ name }) => name),
      ),
    ].filter((name) => !names.has(name))
    return { build, remove }
  }

  /**
   * The plan of an apply. Outside safe mode a repo plugin that is not running is built, and a bundled one only when the
   * apply turns it on or changes its entry, so a bundled plugin a boot skipped does not block every apply. In safe mode
   * every repo plugin that is on is built, as a check, and nothing of it swaps.
   */
  const planOf = (
    loaded: ReadonlyArray<Loader.Loaded>,
    file: Settings.File,
  ) => {
    const desired = PluginSettings.entries({
      file,
      bundled: options.bundled,
      repo: loaded,
      safe: false,
    })
    if (safe !== "off")
      return {
        build: desired.filter(({ bundle }) => bundle !== undefined),
        remove: [],
      }
    const off = Settings.off(applied)
    return planFor(
      desired,
      ({ name, bundle }) =>
        bundle !== undefined ||
        off.has(name) ||
        !Settings.same(
          Settings.settingsOf(applied, name),
          Settings.settingsOf(file, name),
        ),
    )
  }

  /**
   * In safe mode, what an apply or a revert does at once: a bundled plugin it turns off is unloaded and one it turns on
   * is loaded on its defaults, skipped when that fails.
   */
  const flips = (file: Settings.File) => {
    const before = Settings.off(applied)
    const plan = planFor(
      PluginSettings.entries({
        file,
        bundled: options.bundled,
        repo: [],
        safe: true,
      }),
      ({ name }) => before.has(name),
    )
    return {
      build: plan.build,
      remove: plan.remove.filter((name) => bundledNames.has(name)),
    }
  }

  /**
   * An apply or a revert of a tree: the export, the checks and the builds, and then, unless it is only a check, the
   * commit and everything after it.
   */
  const change = (options_: {
    readonly kind: "apply" | "revert" | "check"
    readonly tree: string
    readonly head: string
    readonly message: string
    readonly caller: Caller
  }) =>
    Effect.gen(function* () {
      const { kind, tree, head, caller } = options_
      const exported = yield* Repo.exportTree(repo, tree)
      const cleanup = exported.fresh
        ? Effect.ignore(
            fs.remove(exported.directory, { recursive: true, force: true }),
          )
        : Effect.void
      // The tree's packages are installed and linked before its type-check, which reads them.
      const readied = yield* options.packages.ready(exported.directory).pipe(
        Effect.map((ready) => ({ ready, error: undefined })),
        Effect.catchTag("PackagesError", (error) =>
          Effect.succeed({ ready: undefined, error: error.message }),
        ),
        Effect.onError(() => cleanup),
      )
      if (readied.ready === undefined) {
        yield* cleanup
        return yield* refused("packages", [readied.error])
      }
      const ready = readied.ready
      const packageLines = Packages.changes(
        yield* Packages.listed(
          (yield* fs.exists(live)) ? yield* fs.realPath(live) : undefined,
        ),
        ready.packages,
      )
      const checked = yield* checkTree(exported.directory).pipe(
        Effect.onError(() => cleanup),
      )
      if (checked.errors.length > 0) {
        yield* cleanup
        return yield* refused(checked.stage, checked.errors)
      }
      // `chad.json` is checked against every plugin's name, bundled or in the tree.
      const text = yield* Settings.read(exported.directory)
      const validated =
        text._tag === "Text"
          ? Settings.validate(
              text.text,
              new Set([
                ...bundledNames,
                ...checked.loaded.map(({ name }) => name),
              ]),
            )
          : {
              file: Settings.empty,
              errors: [Messages.settingsNotJson(text.error)],
            }
      if (validated.errors.length > 0) {
        yield* cleanup
        return yield* refused("settings", validated.errors)
      }
      const file = validated.file
      // `mcp.json` is read from the tree the change exported. A malformed file and a relative `cwd` fail the change,
      // and a name that resolves nowhere leaves that server unavailable.
      const mcpRead = yield* McpFile.read(exported.directory)
      if (mcpRead._tag === "Malformed") {
        yield* cleanup
        return yield* refused("mcp", [Messages.mcpRefused(mcpRead.error)])
      }
      const mcpResolved = [...(yield* options.mcp.resolve(mcpRead.file))]
      const relative = mcpResolved.flatMap(([name, { relative }]) =>
        relative === undefined
          ? []
          : [Messages.mcpRelativeCwdRefused(name, relative)],
      )
      if (relative.length > 0) {
        yield* cleanup
        return yield* refused("mcp", relative)
      }
      const mcpWarnings = mcpResolved.flatMap(([name, { missing }]) =>
        missing === undefined
          ? []
          : [Messages.mcpCheckUnresolved(name, missing)],
      )
      // The persona is read from the tree the change exported, never from work/.
      const nextPersona = yield* Persona.read(exported.directory)
      const { build, remove } = planOf(checked.loaded, file)
      const prepared = yield* plugins.prepare({
        build,
        remove,
        reason: "removed",
        failures: "refuse",
        trial: true,
      })
      const replaceMe = prepared.replaceMe
      const abandon = Effect.andThen(prepared.discard, cleanup)
      if (prepared.failed.length > 0) {
        yield* abandon
        return yield* refused(
          "build",
          prepared.failed.map(({ name, error }) =>
            name === "" ? error : Messages.couldNotLoad(name, error),
          ),
        )
      }
      // The keys each plugin built read while loading, and those it did not read, which never fail it.
      const listing = prepared.settings.flatMap(({ name, items, unread }) =>
        Messages.settingsListing(name, items, unread),
      )
      if (kind === "check") {
        yield* abandon
        // The servers an apply would add, remove or change, against the applied tree. Nothing connects.
        const before = yield* McpFile.read(
          (yield* fs.exists(live)) ? yield* fs.realPath(live) : undefined,
        )
        const diff = McpFile.diff(
          before._tag === "File" ? before.file : McpFile.empty,
          mcpRead.file,
        )
        const mcpChanged =
          diff.added.length + diff.removed.length + diff.changed.length > 0
        // "Replace me" is the one finding a check passes with.
        return done(
          ...packageLines,
          ...listing,
          ...replaceMe.map(Messages.replaceMeCheck),
          ...(mcpChanged ? Messages.mcpCheckLines(diff) : []),
          ...mcpWarnings,
          Messages.checkPassed,
        )
      }
      if (replaceMe.length > 0) {
        yield* abandon
        return yield* refused("check", replaceMe.map(Messages.replaceMeRefused))
      }
      const changes = yield* Repo.changed(
        repo,
        yield* Repo.treeOf(work, head),
        tree,
      ).pipe(Effect.onError(() => abandon))
      // A revert saves what `work/` holds before anything moves, and is refused when it would write over something the
      // save did not capture.
      const saved =
        kind === "revert"
          ? yield* Repo.save(repo).pipe(Effect.onError(() => abandon))
          : undefined
      if (saved !== undefined) {
        const blocked = yield* Repo.obstructed(repo, saved.tree, tree).pipe(
          Effect.onError(() => abandon),
        )
        if (blocked.length > 0) {
          yield* abandon
          return yield* refused("revert", [
            Messages.revertObstructed(blocked, saved.ref),
          ])
        }
      }
      // From the commit on the apply finishes even when its client has gone, so the commit itself runs where a client
      // cannot cut it. A graceful stop abandons the swap, and the next boot loads the commit.
      const after = (sha: string) =>
        Effect.gen(function* () {
          yield* Repo.point(repo, tree)
          const restored =
            saved === undefined
              ? yield* Effect.as(Repo.reset(repo, sha), undefined)
              : yield* Repo.restore(repo, {
                  saved: saved.commit,
                  name: saved.ref.split("/").pop()!,
                  sha,
                })
          // The persona is in place before the swap's generation bump, which is its one path to a session.
          persona = nextPersona
          const skillChanges = Skills.changes(
            skills,
            checked.skills,
            changes.map(({ path }) => path),
          )
          skills = checked.skills
          for (const name of skipped) {
            yield* options.notices.clear(Skills.skippedKey(name))
          }
          skipped = new Set()
          // Timers held before the swap fire once each when their plugin loads.
          const heldBefore = (yield* options.timers).filter(
            ({ plugin }) => !plugins.active(plugin),
          )
          const swapped =
            safe === "off"
              ? yield* prepared.swap
              : yield* Effect.as(prepared.discard, undefined)
          // In safe mode a bundled plugin's `enabled` flipped by the change takes effect now.
          const flipped =
            safe === "off"
              ? undefined
              : yield* Effect.gen(function* () {
                  const plan = flips(file)
                  if (plan.build.length === 0 && plan.remove.length === 0)
                    return undefined
                  const prepared = yield* plugins.prepare({
                    ...plan,
                    reason: "removed",
                    failures: "skip",
                    trial: false,
                  })
                  const done = yield* prepared.swap
                  return {
                    on: done.swapped,
                    off: done.removed,
                    failed: prepared.failed,
                  }
                })
          applied = file
          const loadedNow = new Set(swapped?.swapped ?? flipped?.on ?? [])
          const unloadedNow = new Set(swapped?.removed ?? flipped?.off ?? [])
          const timerLines = [
            ...heldBefore
              .filter(
                ({ plugin, overdue }) => loadedNow.has(plugin) && overdue > 0,
              )
              .map(({ plugin, overdue }) =>
                Messages.timersWillFire(plugin, overdue),
              ),
            ...(unloadedNow.size === 0 ? [] : yield* options.timers)
              .filter(({ plugin }) => unloadedNow.has(plugin))
              .map(({ plugin, count }) =>
                Messages.timersHeldLine(plugin, count),
              ),
          ]
          yield* PluginSettings.announce(options.notices, {
            unparsable: undefined,
            ignored: [],
          })
          // A changed `mcp.json` rebuilds the MCP layer once the queue is released, and the plugins do not wait for it.
          // So does a changed lockfile while a server is configured, because a stdio server can be a command of a
          // package, and the install it was started from has just been replaced. In safe mode it loads when safe mode
          // goes off.
          const mcpChanged =
            safe === "off" &&
            changes.some(
              ({ path }) =>
                path === McpFile.fileName ||
                (path === Packages.lockName && mcpRead.file.size > 0),
            )
          if (mcpChanged) {
            options.mcp.set(mcpRead.file)
            yield* options.notices.clear(Mcp.unreadableKey)
          }
          yield* Repo.prune(repo, tree)
          yield* options.packages.prune(ready.hash)
          yield* Logger.event("apply.done", "An apply finished", {
            kind,
            commit: sha,
            caller: Queue.caller(caller.session),
            ...(swapped === undefined
              ? {}
              : {
                  swapped: swapped.swapped.join(","),
                  removed: swapped.removed.join(","),
                }),
          })
          yield* Queue.ran(kind, Queue.caller(caller.session), "changed", {
            commit: sha,
          })
          yield* announce(
            caller,
            kind === "revert"
              ? Messages.revertedLine(sha.slice(0, 7), head.slice(0, 7))
              : Messages.appliedLine(
                  sha.slice(0, 7),
                  Messages.firstLine(options_.message),
                ),
          )
          return {
            mcp: yield* rebuildIf(mcpChanged),
            ...done(
              ...Messages.appliedOutput({
                kind,
                commit: sha.slice(0, 7),
                files: changes.map(({ status, path }) => `${status} ${path}`),
                safe: safe !== "off",
                saved: saved?.ref,
                restored,
                swapped,
                flipped,
                settings: [...packageLines, ...listing, ...timerLines],
                skills: [
                  ...Messages.skillChanges(skillChanges),
                  ...Skills.hiding(skills, options.skills.bundled).map(
                    Messages.skillHides,
                  ),
                ],
              }),
            ),
          } satisfies Performed as Performed
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Logger.event(
                  "apply.failed",
                  "An apply failed after its commit",
                  {
                    stage: "after-commit",
                    commit: sha,
                    error: Messages.firstLine(Cause.pretty(cause)),
                  },
                ).pipe(
                  Effect.as(
                    failed(
                      Messages.failedAfterCommit(
                        sha.slice(0, 7),
                        Messages.firstLine(Cause.pretty(cause)),
                      ),
                    ),
                  ),
                ),
          ),
        )
      return yield* owned(
        Repo.commit(repo, {
          tree,
          parent: head,
          message: options_.message,
          session: caller.session,
        }).pipe(
          Effect.onError(() => abandon),
          Effect.flatMap(after),
        ),
      )
    })

  /**
   * Formats the plugin code in `work/` before a check or an apply snapshots it, and puts what the format did before
   * what the command prints.
   */
  const formatted = <E, R>(command: Effect.Effect<Performed, E, R>) =>
    Effect.gen(function* () {
      const format = yield* Prettier.plugins(work)
      const performed = yield* command
      return {
        ...performed,
        stdout: [...Prettier.lines(format), ...performed.stdout],
      } satisfies Performed as Performed
    })

  const apply = (message: string, caller: Caller) =>
    formatted(
      Effect.gen(function* () {
        const head = yield* Repo.head(work)
        const tree = yield* Repo.snapshot(repo)
        if (head !== undefined && tree === (yield* Repo.treeOf(work, head))) {
          // Nothing changed: no commit and no line in the session.
          return done(Messages.nothingChanged)
        }
        return yield* change({
          kind: "apply",
          tree,
          head: head!,
          message,
          caller,
        })
      }),
    )

  const check = (caller: Caller) =>
    formatted(
      Effect.gen(function* () {
        const head = yield* Repo.head(work)
        const tree = yield* Repo.snapshot(repo)
        return yield* change({
          kind: "check",
          tree,
          head: head!,
          message: "",
          caller,
        })
      }),
    )

  const revert = (commit: string | undefined, caller: Caller) =>
    Effect.gen(function* () {
      const head = yield* Repo.head(work)
      const target =
        head === undefined ? undefined : yield* Repo.target(repo, head, commit)
      if (head === undefined || target === undefined) {
        return failed(
          commit === undefined
            ? Messages.revertNoEarlier
            : Messages.revertNotApplied(commit),
        )
      }
      const tree = yield* Repo.treeOf(work, target)
      // A target with the tree that is applied now changes nothing, as an apply with nothing changed.
      if (tree === (yield* Repo.treeOf(work, head)))
        return done(Messages.nothingChanged)
      return yield* change({
        kind: "revert",
        tree,
        head,
        message: Messages.revertMessage(target.slice(0, 7)),
        caller,
      })
    })

  /**
   * `chad safe on` is a swap to nothing of everything from the repo, and `chad safe off` loads `live` as a boot
   * does, skipping and naming what fails. The toggle is stored first. While `CHAD_SAFE_MODE=1` is set, `off` changes
   * nothing and exits 1.
   */
  const toggle = (to: "on" | "off" | undefined, caller: Caller) =>
    Effect.gen(function* () {
      if (to === undefined) return done(Messages.safeState(safe))
      if (to === "off" && options.forced) return failed(Messages.safeForced)
      if ((to === "on") === (safe !== "off"))
        return done(Messages.safeState(safe))
      // Once the toggle is stored the plugins follow it, so a client that goes away does not leave the two apart.
      return yield* owned(switched(to, caller))
    })

  const switched = (to: "on" | "off", caller: Caller) =>
    Effect.gen(function* () {
      const servers = options.mcp.file()?.size ?? 0
      yield* SafeMode.write(options.data, to === "on")
      if (to === "on") {
        // Everything from the repo goes, and a bundled plugin with settings is built again on its defaults.
        const plan = planFor(
          PluginSettings.entries({
            file: applied,
            bundled: options.bundled,
            repo: [],
            safe: true,
          }),
          () => false,
        )
        const prepared = yield* plugins.prepare({
          ...plan,
          reason: "safe",
          failures: "keep",
          trial: false,
        })
        safe = "toggle"
        yield* prepared.swap
        // Safe mode loads no MCP servers.
        options.mcp.set(undefined)
      } else {
        // `live` loads as a boot loads it, `chad.json` included.
        const tree = (yield* fs.exists(live))
          ? yield* fs.realPath(live)
          : undefined
        const found =
          tree === undefined
            ? { loaded: [], skipped: [] }
            : yield* Loader.load(tree, bundledNames, yield* readyLive(tree))
        applied = yield* PluginSettings.atBoot({
          tree,
          known: new Set([
            ...bundledNames,
            ...found.loaded.map(({ name }) => name),
            ...found.skipped.map(({ name }) => name),
          ]),
          safe: false,
          notices: options.notices,
        })
        persona = yield* Persona.read(tree)
        skills = yield* Skills.scan(
          tree === undefined ? undefined : join(tree, "skills"),
        )
        yield* skipSkills(options.notices, skills)
        skipped = new Set(skills.bad.map(({ name }) => name))
        options.mcp.set(yield* Mcp.atBoot(tree, options.notices))
        const off = Settings.off(applied)
        const plan = planFor(
          PluginSettings.entries({
            file: applied,
            bundled: options.bundled,
            repo: found.loaded,
            safe: false,
          }),
          () => true,
        )
        const prepared = yield* plugins.prepare({
          ...plan,
          reason: "removed",
          failures: "skip",
          trial: false,
          unloadable: found.skipped.filter(({ name }) => !off.has(name)),
        })
        safe = "off"
        yield* prepared.swap
      }
      yield* Queue.ran(`safe ${to}`, Queue.caller(caller.session), "changed")
      yield* announce(caller, Messages.safeLine(to === "on"))
      // The MCP layer follows when there were servers before or are now.
      return {
        ...done(Messages.safeState(safe)),
        mcp: yield* rebuildIf(servers + (options.mcp.file()?.size ?? 0) > 0),
      } satisfies Performed as Performed
    })

  /**
   * The entry a reload builds for one plugin: the running version's, or for one that is not running, the bundled one or
   * the one in `live`, with its settings from the applied `chad.json`. Without one, `refused` says why. `unloadable` is
   * set when the plugin is in `live` and its module could not be loaded, which is a failure of the reload and not a
   * plugin it leaves out on purpose, as it leaves out one that is off, unknown or from the repo in safe mode.
   */
  const entryOf = (name: string) =>
    Effect.gen(function* () {
      const refused = (text: string): NoEntry => ({ refused: text })
      // A plugin that is off is not loaded, since the applied file says it is off.
      if (Settings.off(applied).has(name))
        return refused(Messages.reloadOff(name))
      const running = plugins
        .versions()
        .find((version) => version.name === name)
      if (running !== undefined) return running.entry
      const withSettings = (repo: ReadonlyArray<Loader.Loaded>) =>
        PluginSettings.entries({
          file: applied,
          bundled: options.bundled,
          repo,
          safe: safe !== "off",
        }).find((entry) => entry.name === name)
      const bundled = withSettings([])
      if (bundled !== undefined) return bundled
      if (safe !== "off") return refused(Messages.reloadSafe(name))
      if (
        !plugins.skipped().some((skipped) => skipped.name === name) ||
        !(yield* fs.exists(live))
      ) {
        return refused(Messages.reloadUnknown(name))
      }
      const tree = yield* fs.realPath(live)
      const found = yield* Loader.load(
        tree,
        bundledNames,
        yield* readyLive(tree),
      )
      const loaded = withSettings(found.loaded)
      if (loaded !== undefined) return loaded
      const problem = found.skipped.find((plugin) => plugin.name === name)
      return problem === undefined
        ? refused(Messages.reloadUnknown(name))
        : ({
            refused: Messages.couldNotLoad(name, problem.message),
            unloadable: problem.message,
          } satisfies NoEntry as NoEntry)
    })

  /**
   * `chad plugin reload <name>` builds one plugin again, a skipped one included, and swaps it when the build succeeds.
   * A failed build keeps the running version and exits 1 with the error.
   */
  const reload = (name: string) =>
    Effect.gen(function* () {
      const entry = yield* entryOf(name)
      if ("refused" in entry) return failed(entry.refused)
      const prepared = yield* plugins.prepare({
        build: [entry],
        remove: [],
        reason: "removed",
        failures: "keep",
        kept: "instance",
        trial: false,
      })
      const failure = prepared.failed[0]
      if (failure !== undefined)
        return failed(Messages.couldNotLoad(name, failure.error))
      yield* prepared.swap
      return done(Messages.reloaded(name))
    })

  /**
   * `chad timezone <zone>` stores the zone, then builds every loaded plugin again with it and swaps them in one swap. A
   * plugin whose build fails keeps its old version and the command exits 1 naming it, with the change kept. The line
   * in the session's thread names the plugins that were kept.
   */
  const timezone = (zone: string, caller: Caller) =>
    Effect.gen(function* () {
      const canonical = Timezone.canonical(zone)
      if (canonical === undefined) return failed(Messages.timezoneInvalid(zone))
      return yield* owned(
        Effect.gen(function* () {
          yield* Timezone.write(options.data, canonical)
          options.zoned(canonical)
          const prepared = yield* plugins.prepare({
            build: plugins.versions().map(({ entry }) => entry),
            remove: [],
            reason: "removed",
            failures: "keep",
            kept: "timezone",
            trial: false,
          })
          yield* prepared.swap
          const kept = prepared.failed.map(({ name }) => name)
          yield* Queue.ran(
            "timezone",
            Queue.caller(caller.session),
            "changed",
            { zone: canonical },
          )
          yield* announce(caller, Messages.timezoneLine(canonical, kept))
          return prepared.failed.length === 0
            ? done(Messages.timezoneSet(canonical))
            : {
                stdout: [Messages.timezoneSet(canonical)],
                stderr: prepared.failed.map(({ name, error }) =>
                  Messages.keptPrevious(name, error),
                ),
                code: 1 as const,
              }
        }),
      )
    })

  /** See `Commands.rebuild`. */
  const rebuild: Commands["rebuild"] = (names, kept) =>
    owned(
      Effect.gen(function* () {
        const build: Array<Plugins.Entry> = []
        const unreadable: Array<{ name: string; error: string }> = []
        for (const name of new Set(names)) {
          const entry = yield* Effect.result(entryOf(name))
          if (entry._tag === "Failure")
            unreadable.push({ name, error: String(entry.failure) })
          else if (!("refused" in entry.success)) build.push(entry.success)
          // A module in `live` that could not be loaded fails the reload like a build that failed.
          else if (entry.success.unloadable !== undefined)
            unreadable.push({ name, error: entry.success.unloadable })
        }
        const prepared = yield* plugins.prepare({
          build,
          remove: [],
          reason: "removed",
          failures: "keep",
          kept,
          trial: false,
        })
        const { swapped } = yield* prepared.swap
        return { swapped, failed: [...unreadable, ...prepared.failed] }
      }).pipe(Effect.provideContext(context)),
    )

  /**
   * `chad secret set` and `chad secret rm`. The store changes first, by temporary file and rename, then the plugins whose
   * settings in the applied `chad.json` name the secret are built again, one a boot skipped included and one that is off
   * left out. A plugin whose build fails keeps its old version, marked in status, and the command exits 1 naming it,
   * with the change kept. Once the store is written the reload finishes whether or not the CLI stays. A removal run
   * from a session posts its line there. What comes back holds names and never the value, and so does the
   * `command.ran` line.
   */
  const secret = (
    request: Extract<Request, { readonly _tag: "SecretSet" | "SecretRm" }>,
    caller: Caller,
  ) =>
    Effect.gen(function* () {
      const set = request._tag === "SecretSet"
      const command = set ? "secret set" : "secret rm"
      const who = Queue.caller(caller.session)
      const { name } = request
      if (set && !Secrets.valid(name))
        return failed(
          name === Secrets.RESERVED
            ? Messages.secretNameReserved()
            : Messages.secretNameInvalid(),
        )
      if (set && request.value === "") return failed(Messages.secretNoValue())
      return yield* owned(
        Effect.gen(function* () {
          const changed = yield* Secrets.change(options.data, (store) =>
            set
              ? Secrets.save(
                  store,
                  name,
                  request.value,
                  request.note,
                  new Date(),
                )
              : Secrets.remove(store, name),
          ).pipe(
            Effect.mapError((error) =>
              Messages.secretStoreBroken(
                set ? "set" : "rm",
                error._tag === "SecretsError"
                  ? error.message
                  : `secrets/secrets.json cannot be written (${Errno.code(error)})`,
              ),
            ),
            Effect.result,
          )
          if (changed._tag === "Failure") {
            yield* Queue.ran(command, who, "refused", { name })
            return failed(changed.failure)
          }
          if (changed.success._tag === "Missing") {
            yield* Queue.ran(command, who, "unchanged", { name })
            return failed(Messages.secretMissing("rm", name))
          }
          const { swapped, failed: kept } = yield* rebuild(
            PluginSettings.users(applied, name),
            "secret",
          )
          yield* Queue.ran(command, who, "changed", { name })
          // The MCP layer is rebuilt when `mcp.json` names the secret, and only then.
          const mcp = McpFile.names(options.mcp.file()).has(name)
          const line =
            changed.success._tag === "Saved"
              ? Messages.secretSaved(name, changed.success.replaced, swapped)
              : Messages.secretRemoved(name, swapped)
          if (!set)
            yield* announce(
              caller,
              Messages.secretLine(
                name,
                kept.map(({ name }) => name),
              ),
            )
          return {
            stdout: [line],
            stderr: kept.map(({ name, error }) =>
              Messages.keptPrevious(name, error),
            ),
            code: kept.length === 0 ? (0 as const) : (1 as const),
            mcp: yield* rebuildIf(mcp),
          } satisfies Performed as Performed
        }),
      )
    })

  /**
   * `chad plugin purge <name>` drops the key-value table of a plugin that is gone. It refuses a plugin that is still in
   * the applied repo, one that is off or that a boot skipped included, and a bundled plugin that is on, so a loaded
   * plugin never loses its data underneath it. A plugin with no table changes nothing and
   * posts nothing.
   */
  const purge = (name: string, caller: Caller) =>
    Effect.gen(function* () {
      if (bundledNames.has(name)) {
        if (!Settings.off(applied).has(name))
          return failed(Messages.purgeBundledOn(name))
      } else {
        const tree = (yield* fs.exists(live))
          ? yield* fs.realPath(live)
          : undefined
        const { found, problems } =
          tree === undefined
            ? { found: [], problems: [] }
            : yield* Loader.discover(tree)
        if ([...found, ...problems].some((plugin) => plugin.name === name))
          return failed(Messages.purgeInRepo(name))
      }
      const keys = yield* owned(options.drop(name))
      // A plugin's timers go with its table, and with nothing else.
      const timers = yield* owned(options.purgeTimers(name))
      if (keys === undefined && timers === 0)
        return done(Messages.purgeNothing(name))
      yield* Queue.ran(
        "plugin purge",
        Queue.caller(caller.session),
        "changed",
        {
          plugin: name,
        },
      )
      yield* announce(caller, Messages.purgedLine(name))
      return done(
        keys === undefined
          ? Messages.purgedTimers(name, timers)
          : Messages.purged(name, keys, timers),
      )
    })

  const labels: Record<Request["_tag"], string> = {
    Apply: "chad apply",
    Check: "chad check",
    Revert: "chad revert",
    Safe: "chad safe",
    Reload: "chad plugin reload",
    Timezone: "chad timezone",
    SecretSet: "chad secret set",
    SecretRm: "chad secret rm",
    Purge: "chad plugin purge",
    McpRestart: "chad mcp restart",
    McpLoginStart: "chad mcp login",
    McpLoginFinish: "chad mcp login",
    McpLogout: "chad mcp logout",
  }

  /**
   * The owner's sign-in to an MCP server and its sign-out. A session's own process is refused, as the CLI refuses it
   * before it asks. A sign-in that finished and a sign-out rebuild the layer, which is what brings the server up or
   * takes it down.
   */
  const sign = Effect.fnUntraced(function* (
    request: Extract<
      Request,
      { readonly _tag: "McpLoginStart" | "McpLoginFinish" | "McpLogout" }
    >,
    caller: Caller,
  ) {
    const command = request._tag === "McpLogout" ? "mcp logout" : "mcp login"
    const who = Queue.caller(caller.session)
    const { server } = request
    if (caller.session !== undefined) {
      yield* Queue.ran(command, who, "refused", { server })
      return failed(Messages.ownerRefused(command, caller.session))
    }
    if (request._tag === "McpLoginStart") {
      const begun = yield* Effect.result(options.mcp.login.begin(server))
      if (begun._tag === "Failure") return failed(begun.failure)
      return done(...Messages.mcpLoginOpen(server, begun.success))
    }
    return yield* owned(
      Effect.gen(function* () {
        if (request._tag === "McpLogout") {
          const dropped = yield* Effect.result(options.mcp.login.logout(server))
          if (dropped._tag === "Failure" || !dropped.success) {
            yield* Queue.ran(command, who, "unchanged", { server })
            return failed(
              dropped._tag === "Failure"
                ? dropped.failure
                : Messages.mcpLogoutNothing(server),
            )
          }
          yield* Queue.ran(command, who, "changed", { server })
          return {
            ...done(Messages.mcpLoggedOut(server)),
            mcp: yield* rebuildIf(options.mcp.file()?.has(server) === true),
          } satisfies Performed as Performed
        }
        const finished = yield* Effect.result(
          options.mcp.login.finish(server, request.address),
        )
        if (finished._tag === "Failure") {
          yield* Queue.ran(command, who, "refused", { server })
          return failed(finished.failure)
        }
        yield* Queue.ran(command, who, "changed", { server })
        return {
          ...done(Messages.mcpLoggedIn(server)),
          mcp: yield* rebuildIf(true),
        } satisfies Performed as Performed
      }),
    )
  })

  const perform = (
    request: Request,
    caller: Caller,
  ): Effect.Effect<Performed, unknown, Services> => {
    switch (request._tag) {
      case "Apply":
        return apply(request.message, caller)
      case "Check":
        return check(caller)
      case "Revert":
        return revert(request.commit, caller)
      case "Safe":
        return toggle(request.to, caller)
      case "Reload":
        return reload(request.name)
      case "Timezone":
        return timezone(request.zone, caller)
      case "SecretSet":
      case "SecretRm":
        return secret(request, caller)
      case "Purge":
        return purge(request.name, caller)
      case "McpRestart":
        return owned(
          Queue.ran(
            "mcp restart",
            Queue.caller(caller.session),
            "changed",
          ).pipe(
            Effect.andThen(rebuildIf(true)),
            Effect.map((mcp): Performed => ({ ...done(), mcp })),
          ),
        )
      case "McpLoginStart":
      case "McpLoginFinish":
      case "McpLogout":
        return sign(request, caller)
    }
  }

  const commands: Commands = {
    run: (request, caller, waiting, print) =>
      Effect.gen(function* () {
        // `chad safe` with no argument only reads.
        if (request._tag === "Safe" && request.to === undefined)
          return done(Messages.safeState(safe))
        const busy = options.queue.busy()
        if (busy !== undefined) yield* waiting(Messages.queueWaiting(busy))
        const { mcp, ...output }: Performed = yield* options.queue.run(
          perform(request, caller).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Logger.event("apply.failed", "A command failed", {
                    stage: request._tag.toLowerCase(),
                    error: Messages.firstLine(Cause.pretty(cause)),
                  }).pipe(
                    Effect.as(failed(Messages.firstLine(Cause.pretty(cause)))),
                  ),
            ),
            Effect.provideContext(context),
          ),
          labels[request._tag],
        )
        if (mcp === undefined) return output
        // What the command printed comes first, the commit line of an apply included, and the rebuild, which the
        // command started in a fiber a CLI that goes away does not stop, is waited for once the queue is released. An
        // apply's closing line stays last.
        const closing = output.stdout.at(-1) === Messages.appliedClosing
        const head = closing ? output.stdout.slice(0, -1) : output.stdout
        const before =
          print === undefined || head.length === 0
            ? head
            : yield* Effect.as(print(head), [])
        const servers = yield* mcp
        return {
          ...output,
          stdout: [
            ...before,
            ...Messages.mcpRebuilt(servers),
            ...(closing ? [Messages.appliedClosing] : []),
          ],
        }
      }),
    safe: () => safe,
    persona: () => persona,
    skills: () =>
      Skills.provided({
        repo: safe === "off" ? skills : undefined,
        bundled: options.skills.bundled,
        bundledDirectory: options.skills.bundledDirectory,
        repoDirectory: repo,
      }),
    hiding: () =>
      safe === "off" ? Skills.hiding(skills, options.skills.bundled) : [],
    // Once the owners are stored the plugins follow them, so a client that goes away does not leave a removed owner in
    // a running plugin.
    owners: (removed) =>
      owned(
        Effect.gen(function* () {
          const prepared = yield* plugins.prepare({
            build: plugins.versions().map(({ entry }) => entry),
            remove: [],
            reason: "removed",
            failures: removed ? "skip" : "keep",
            kept: "owners",
            trial: false,
          })
          yield* prepared.swap
        }),
      ),
    off: () =>
      new Set(
        [...Settings.off(applied, safe !== "off")].filter(
          (name) =>
            bundledNames.has(name) || Object.hasOwn(applied.plugins, name),
        ),
      ),
    users: (secret) => PluginSettings.users(applied, secret),
    rebuild,
  }
  return commands
})

/**
 * Skips the malformed skills of a tree that a boot or `chad safe off` loads, each with a notice, and clears the notice
 * of each skill that loads.
 */
export const skipSkills = (
  notices: Notices.Notices["Service"],
  found: Skills.Found,
) =>
  Effect.gen(function* () {
    for (const { name, problem } of found.bad) {
      yield* Logger.event("skill.skipped", "A skill was skipped", {
        skill: name,
        error: problem,
      })
      yield* notices.raise({
        key: Skills.skippedKey(name),
        text: Messages.skillSkipped(name, problem),
      })
    }
    for (const { name } of found.skills) {
      yield* notices.clear(Skills.skippedKey(name))
    }
  })
