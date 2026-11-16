/**
 * The commands that change what is loaded from the repo: `chad apply`, `chad check`, `chad revert`, `chad safe` and
 * `chad plugin reload`, `chad timezone`, which reloads every plugin, and `chad plugin purge`, which drops the data of a
 * plugin that is gone (docs/spec/08-apply-and-swap.md, 09-repo-and-recovery.md, 10-cli.md). Each runs alone through
 * the daemon's one queue (SWAP-40). An apply checks and builds everything before its commit, so a failure changes
 * nothing, and from its commit on it runs in a fiber of the daemon's scope that the client cannot interrupt (CLI-43,
 * CLI-44, REC-34).
 */
import { join } from "node:path"
import { Cause, Effect, Fiber, FileSystem, Path, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import * as Errno from "../Errno.ts"
import * as Messages from "../Messages.ts"
import * as Repo from "../Repo.ts"
import * as SafeMode from "../SafeMode.ts"
import * as Secrets from "../Secrets.ts"
import * as Settings from "../Settings.ts"
import * as Timezone from "../Timezone.ts"
import * as Loader from "./Loader.ts"
import * as Logger from "./Logger.ts"
import type * as Notices from "./Notices.ts"
import * as Persona from "./Persona.ts"
import * as PluginSettings from "./PluginSettings.ts"
import type * as Plugins from "./Plugins.ts"
import * as Queue from "./Queue.ts"

/** What a command prints and its exit code. */
export interface Output {
  readonly stdout: ReadonlyArray<string>
  readonly stderr: ReadonlyArray<string>
  readonly code: 0 | 1
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

/** The most errors a failed check prints before it counts the rest (CLI-47). */
const shown = 20

/** Who ran a command: the session from `CHAD_SESSION`, or nothing for the owner's shell. */
export interface Caller {
  readonly session: string | undefined
  /** Whether it was typed in chat, as `/safe` is, whose own output is already in the thread (REC-118). */
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

export interface Commands {
  /** Runs a command in the queue. `waiting` is told what it waits on when the queue is busy (CLI-40). */
  readonly run: (
    request: Request,
    caller: Caller,
    waiting: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<Output>
  /** Whether safe mode is on now, and what turned it on (REC-129). */
  readonly safe: () => SafeMode.State
  /**
   * Builds every loaded plugin again after an owner change, which plugins read as `PluginContext.owners`, and swaps
   * them. It runs inside the queue the owner change holds. With an owner removed, one that fails is unloaded (CLI-120b).
   */
  readonly owners: (removed: boolean) => Effect.Effect<void>
  /** The persona of the applied tree, which a session takes when its Agent is built (SELF-43, SWAP-128). */
  readonly persona: () => string
  /** The plugins the applied `chad.json` turns off, which `chad status` and `chad plugin purge` read (SET-34). */
  readonly off: () => ReadonlySet<string>
  /** The plugins whose settings in the applied `chad.json` name a secret, less those that are off (SET-26, SET-79). */
  readonly users: (secret: string) => ReadonlyArray<string>
  /**
   * Builds the named plugins again through the swap path and swaps those that built, a plugin a boot skipped included.
   * One that fails keeps its running version, marked with `kept`. A name that is off or unknown is left out. It runs
   * inside the queue the caller holds (SWAP-96, SET-79, SET-80).
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
  /** The bundled plugins, by name, which a repo plugin may not share and which `chad plugin reload` builds again. */
  readonly bundled: ReadonlyArray<Plugins.Entry>
  /** The applied `chad.json` as the boot read it. */
  readonly settings: Settings.File
  /** The applied tree's persona as the boot read it. */
  readonly persona: string
  /**
   * Drops a plugin's key-value table, and gives the number of keys it held, or nothing when there was no table
   * (STO-61, CLI-90).
   */
  readonly drop: (name: string) => Effect.Effect<number | undefined>
  /** The notices, of which an apply clears the two about `chad.json` once the file it applied passed its checks. */
  readonly notices: Notices.Notices["Service"]
  readonly queue: Queue.Queue
  /** The daemon's scope, which an apply's steps from the commit on and a session's line run in. */
  readonly scope: Scope.Scope
  /** Takes the owner's timezone that `chad timezone` stored, before the plugins are built with it (API-17). */
  readonly zoned: (zone: string) => void
  /** Posts one line of subtext in a session's thread (REC-108). */
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
  /** The applied tree's persona, which an apply or a revert replaces before its swap bumps the generation (SWAP-128). */
  let persona = options.persona
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

  /** A line in the session's thread, forked into the daemon's scope and not waited for (CLI-44, FAIL-180, REC-104). */
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
   * it, and a stop still does, since the forked fiber is interruptible even when its caller is not (CLI-43, CLI-120b,
   * REC-56).
   */
  const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.forkIn(effect, options.scope).pipe(
      Effect.flatMap((fiber) => Effect.uninterruptible(Fiber.join(fiber))),
    )

  const refused = (stage: string, errors: ReadonlyArray<string>) =>
    Logger.event("apply.failed", "An apply was refused", {
      stage,
      error: errors.join("\n").slice(0, 4000),
    }).pipe(Effect.as(failed(...errorLines(errors))))

  /** Every repo plugin of a tree, checked and run, before any Layer is built (LOAD-53, CLI-67). */
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
        }
      }
      const { errors, loaded } = yield* Loader.check(
        repo,
        directory,
        bundledNames,
      )
      return { stage: "check", errors, loaded }
    })

  /**
   * What to build and what to unload so that the running plugins are `desired`. A running plugin is built again when
   * its bundle hash or its settings before expansion differ from the running version's, and `retry` says whether one
   * that is not running is built. Every running or skipped plugin that is not desired is unloaded: a repo plugin that
   * is gone and a plugin that is off (LOAD-50, LOAD-52, LOAD-88, SET-35, SET-62, SWAP-41).
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
   * every repo plugin that is on is built, as a check, and nothing of it swaps (SWAP-57).
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
   * is loaded on its defaults, skipped when that fails (SET-47, REC-63, SWAP-58).
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
      const checked = yield* checkTree(exported.directory).pipe(
        Effect.onError(() => cleanup),
      )
      if (checked.errors.length > 0) {
        yield* cleanup
        return yield* refused(checked.stage, checked.errors)
      }
      // `chad.json` is checked against every plugin's name, bundled or in the tree (SET-49 to SET-53, SET-87 to
      // SET-89).
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
      // The persona is read from the tree the change exported, never from work/ (REC-11).
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
      // The keys each plugin built read while loading, and those it did not read, which never fail it (SET-55, SET-66,
      // SET-68).
      const listing = prepared.settings.flatMap(({ name, items, unread }) =>
        Messages.settingsListing(name, items, unread),
      )
      if (kind === "check") {
        yield* abandon
        // "Replace me" is the one finding a check passes with (CLI-163, CLI-164).
        return done(
          ...listing,
          ...replaceMe.map(Messages.replaceMeCheck),
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
      // save did not capture (REC-82, REC-137, REC-139, REC-154).
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
      // cannot cut it. A graceful stop abandons the swap, and the next boot loads the commit (CLI-43, CLI-44, LOAD-55).
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
          // The persona is in place before the swap's generation bump, which is its one path to a session (SWAP-128).
          persona = nextPersona
          const swapped =
            safe === "off"
              ? yield* prepared.swap
              : yield* Effect.as(prepared.discard, undefined)
          // In safe mode a bundled plugin's `enabled` flipped by the change takes effect now (SET-47).
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
          yield* PluginSettings.announce(options.notices, {
            unparsable: undefined,
            ignored: [],
          })
          yield* Repo.prune(repo, tree)
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
          return done(
            ...Messages.appliedOutput({
              kind,
              commit: sha.slice(0, 7),
              files: changes.map(({ status, path }) => `${status} ${path}`),
              safe: safe !== "off",
              saved: saved?.ref,
              restored,
              swapped,
              flipped,
              settings: listing,
            }),
          )
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

  const apply = (message: string, caller: Caller) =>
    Effect.gen(function* () {
      const head = yield* Repo.head(work)
      const tree = yield* Repo.snapshot(repo)
      if (head !== undefined && tree === (yield* Repo.treeOf(work, head))) {
        // Nothing changed: no commit and no line in the session (CLI-64, REC-33, REC-117).
        return done(Messages.nothingChanged)
      }
      return yield* change({
        kind: "apply",
        tree,
        head: head!,
        message,
        caller,
      })
    })

  const check = (caller: Caller) =>
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
    })

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
      // A target with the tree that is applied now changes nothing, as an apply with nothing changed (REC-142).
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
   * nothing and exits 1 (REC-56 to REC-60, REC-128, CLI-82, CLI-169).
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
      yield* SafeMode.write(options.data, to === "on")
      if (to === "on") {
        // Everything from the repo goes, and a bundled plugin with settings is built again on its defaults (SET-46).
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
      } else {
        // `live` loads as a boot loads it, `chad.json` included (REC-60).
        const tree = (yield* fs.exists(live))
          ? yield* fs.realPath(live)
          : undefined
        const found =
          tree === undefined
            ? { loaded: [], skipped: [] }
            : yield* Loader.load(tree, bundledNames)
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
      return done(Messages.safeState(safe))
    })

  /**
   * The entry a reload builds for one plugin: the running version's, or for one that is not running, the bundled one or
   * the one in `live`, with its settings from the applied `chad.json`. A text says why there is none.
   */
  const entryOf = (name: string) =>
    Effect.gen(function* () {
      // A plugin that is off is not loaded, since the applied file says it is off (SET-83, SWAP-144).
      if (Settings.off(applied).has(name)) return Messages.reloadOff(name)
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
      if (safe !== "off") return Messages.reloadSafe(name)
      if (
        !plugins.skipped().some((skipped) => skipped.name === name) ||
        !(yield* fs.exists(live))
      ) {
        return Messages.reloadUnknown(name)
      }
      const found = yield* Loader.load(yield* fs.realPath(live), bundledNames)
      const loaded = withSettings(found.loaded)
      if (loaded !== undefined) return loaded
      const problem = found.skipped.find((plugin) => plugin.name === name)
      return problem === undefined
        ? Messages.reloadUnknown(name)
        : Messages.couldNotLoad(name, problem.message)
    })

  /**
   * `chad plugin reload <name>` builds one plugin again, a skipped one included, and swaps it when the build succeeds.
   * A failed build keeps the running version and exits 1 with the error (CLI-88, CLI-171, SWAP-95, REC-123).
   */
  const reload = (name: string) =>
    Effect.gen(function* () {
      const entry = yield* entryOf(name)
      if (typeof entry === "string") return failed(entry)
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
   * plugin whose build fails keeps its old version and the command exits 1 naming it, with the change kept (CLI-114,
   * SWAP-96, SWAP-97). The line in the session's thread names the plugins that were kept (CLI-150, FAIL-238).
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
          else if (typeof entry.success !== "string") build.push(entry.success)
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
   * with the change kept. Once the store is written the reload finishes whether or not the CLI stays (CRED-25, CLI-102,
   * SET-26, SET-79, SET-80, SWAP-96, SWAP-97, SWAP-143). A removal run from a session posts its line there (CRED-106,
   * FAIL-238). What comes back holds names and never the value (CRED-81), and so does the `command.ran` line (CRED-130).
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
          }
        }),
      )
    })

  /**
   * `chad plugin purge <name>` drops the key-value table of a plugin that is gone. It refuses a plugin that is still in
   * the applied repo, one that is off or that a boot skipped included, and a bundled plugin that is on, so a loaded
   * plugin never loses its data underneath it (CLI-90, SET-40, SET-95). A plugin with no table changes nothing and
   * posts nothing (CLI-248).
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
      if (keys === undefined) return done(Messages.purgeNothing(name))
      yield* Queue.ran(
        "plugin purge",
        Queue.caller(caller.session),
        "changed",
        {
          plugin: name,
        },
      )
      yield* announce(caller, Messages.purgedLine(name))
      return done(Messages.purged(name, keys))
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
  }

  const perform = (
    request: Request,
    caller: Caller,
  ): Effect.Effect<Output, unknown, Services> => {
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
    }
  }

  const commands: Commands = {
    run: (request, caller, waiting) =>
      Effect.gen(function* () {
        // `chad safe` with no argument only reads (REC-129).
        if (request._tag === "Safe" && request.to === undefined)
          return done(Messages.safeState(safe))
        const busy = options.queue.busy()
        if (busy !== undefined) yield* waiting(Messages.queueWaiting(busy))
        return yield* options.queue.run(
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
      }),
    safe: () => safe,
    persona: () => persona,
    // Once the owners are stored the plugins follow them, so a client that goes away does not leave a removed owner in
    // a running plugin (CLI-120b, SWAP-99).
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
    off: () => Settings.off(applied),
    users: (secret) => PluginSettings.users(applied, secret),
    rebuild,
  }
  return commands
})
