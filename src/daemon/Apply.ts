/**
 * The commands that change what is loaded from the repo: `chad apply`, `chad check`, `chad revert`, `chad safe` and
 * `chad plugin reload` (docs/spec/08-apply-and-swap.md, 09-repo-and-recovery.md, 10-cli.md). Each runs alone through
 * the daemon's one queue (SWAP-40). An apply checks and builds everything before its commit, so a failure changes
 * nothing, and from its commit on it runs in a fiber of the daemon's scope that the client cannot interrupt (CLI-43,
 * CLI-44, REC-34).
 */
import { join } from "node:path"
import { Cause, Effect, Fiber, FileSystem, Path, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import * as Messages from "../Messages.ts"
import * as Repo from "../Repo.ts"
import * as SafeMode from "../SafeMode.ts"
import * as Loader from "./Loader.ts"
import * as Logger from "./Logger.ts"
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
  readonly queue: Queue.Queue
  /** The daemon's scope, which an apply's steps from the commit on and a session's line run in. */
  readonly scope: Scope.Scope
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
   * The plan of an apply: a repo plugin whose bundle hash differs from the running version's, or that has none
   * running, is built, and a running repo plugin that the tree no longer has is removed. Every other plugin is left as
   * it is and is not part of the swap (LOAD-50, LOAD-52, SWAP-41). In safe mode every repo plugin is built, as a
   * check, and nothing swaps (SWAP-57).
   */
  const planOf = (loaded: ReadonlyArray<Loader.Loaded>) => {
    const running = new Map(
      plugins.versions().map((version) => [version.name, version]),
    )
    const entries = loaded.map(({ name, plugin, bundle }): Plugins.Entry => ({
      name,
      plugin,
      bundle,
    }))
    const build =
      safe === "off"
        ? entries.filter(
            ({ name, bundle }) => running.get(name)?.hash !== bundle?.hash,
          )
        : entries
    const names = new Set(entries.map(({ name }) => name))
    const remove = [
      ...plugins
        .versions()
        .filter(({ name, hash }) => hash !== undefined && !names.has(name)),
      ...plugins
        .skipped()
        .filter(({ name, repo }) => repo === true && !names.has(name)),
    ].map(({ name }) => name)
    return { build, remove }
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
      const { build, remove } = planOf(checked.loaded)
      const prepared = yield* plugins.prepare({
        build,
        remove: safe === "off" ? remove : [],
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
      if (kind === "check") {
        yield* abandon
        // "Replace me" is the one finding a check passes with (CLI-163, CLI-164).
        return done(
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
          const swapped =
            safe === "off"
              ? yield* prepared.swap
              : yield* Effect.as(prepared.discard, undefined)
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
        const remove = [
          ...plugins.versions().filter(({ hash }) => hash !== undefined),
          ...plugins.skipped().filter(({ repo }) => repo === true),
        ].map(({ name }) => name)
        const prepared = yield* plugins.prepare({
          build: [],
          remove,
          reason: "safe",
          failures: "keep",
          trial: false,
        })
        safe = "toggle"
        yield* prepared.swap
      } else {
        const found = (yield* fs.exists(live))
          ? yield* Loader.load(yield* fs.realPath(live), bundledNames)
          : { loaded: [], skipped: [] }
        const prepared = yield* plugins.prepare({
          build: found.loaded.map(({ name, plugin, bundle }) => ({
            name,
            plugin,
            bundle,
          })),
          remove: [],
          reason: "removed",
          failures: "skip",
          trial: false,
          unloadable: found.skipped,
        })
        safe = "off"
        yield* prepared.swap
      }
      yield* Queue.ran(`safe ${to}`, Queue.caller(caller.session), "changed")
      yield* announce(caller, Messages.safeLine(to === "on"))
      return done(Messages.safeState(safe))
    })

  /**
   * `chad plugin reload <name>` builds one plugin again, a skipped one included, and swaps it when the build succeeds.
   * A failed build keeps the running version and exits 1 with the error (CLI-88, CLI-171, SWAP-95, REC-123).
   */
  const reload = (name: string) =>
    Effect.gen(function* () {
      const running = plugins
        .versions()
        .find((version) => version.name === name)
      const entry: Plugins.Entry | string = yield* Effect.gen(function* () {
        if (running !== undefined) return running.entry
        const bundled = options.bundled.find((entry) => entry.name === name)
        if (bundled !== undefined) return bundled
        if (safe !== "off") return Messages.reloadSafe(name)
        if (
          !plugins.skipped().some((skipped) => skipped.name === name) ||
          !(yield* fs.exists(live))
        ) {
          return Messages.reloadUnknown(name)
        }
        const found = yield* Loader.load(yield* fs.realPath(live), bundledNames)
        const loaded = found.loaded.find((plugin) => plugin.name === name)
        if (loaded !== undefined)
          return { name, plugin: loaded.plugin, bundle: loaded.bundle }
        const problem = found.skipped.find((plugin) => plugin.name === name)
        return problem === undefined
          ? Messages.reloadUnknown(name)
          : Messages.couldNotLoad(name, problem.message)
      })
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

  const labels: Record<Request["_tag"], string> = {
    Apply: "chad apply",
    Check: "chad check",
    Revert: "chad revert",
    Safe: "chad safe",
    Reload: "chad plugin reload",
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
  }
  return commands
})
