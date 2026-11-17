/**
 * The repo on the volume: the git repo at `repo/work/` where the agent edits, the
 * exported trees under `repo/versions/<tree>/` and the `repo/live` link to the one that is loaded. The applied
 * history is the `applied` branch of that repo, one commit per apply or revert, and git is the only store of it.
 */
import { randomBytes } from "node:crypto"
import { rmdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Data, Effect, FileSystem, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** A git command that failed, with what it printed. */
export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string
}> {}

/** The identity of the applied commits, which the repo's own config holds. */
export const identity = { name: "chad", email: "chad@localhost" } as const

/** The branch of the applied history, and the branch checked out in `work/`. */
export const applied = "applied"
export const main = "main"

/** The trailer that records the session that ran an apply. */
export const sessionTrailer = "Chad-Session"

export const paths = (repo: string) => ({
  work: join(repo, "work"),
  versions: join(repo, "versions"),
  live: join(repo, "live"),
})

const unique = () => randomBytes(6).toString("hex")

/** Runs git in a directory and gives what it printed on stdout, trimmed. A non-zero exit is a `GitError`. */
export const git = Effect.fnUntraced(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [stdout, stderr, code] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", args, {
          cwd,
          extendEnv: true,
          // No config outside the repo changes what chad commits or how it reads the history.
          env: { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env },
        }),
      )
      return yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      )
    }),
  ).pipe(
    Effect.mapError(
      (error) => new GitError({ message: `git ${args[0]}: ${error.message}` }),
    ),
  )
  if (code !== 0) {
    return yield* new GitError({
      message: `git ${args.join(" ")}: ${(stderr || stdout).trim()}`,
    })
  }
  return stdout.trim()
})

/** The head of the `applied` branch, or nothing when the repo has none. */
export const head = (work: string) =>
  git(work, ["rev-parse", "--verify", "-q", `refs/heads/${applied}`]).pipe(
    Effect.map((sha) => (sha === "" ? undefined : sha)),
    Effect.orElseSucceed(() => undefined),
  )

/** The tree of a commit. */
export const treeOf = (work: string, commit: string) =>
  git(work, ["rev-parse", `${commit}^{tree}`])

/**
 * What a snapshot and the draft leave out whatever `.gitignore` says: a `node_modules` at any depth, the entry itself
 * as well as what is under it, so neither a directory nor a link of that name gets in. chad installs the packages of a
 * tree itself, so one the agent made is never loaded and never applied.
 */
const derived = [
  ":(exclude,glob)**/node_modules",
  ":(exclude,glob)**/node_modules/**",
]

/**
 * A snapshot of `work/` as one tree: `git add -A` into a temporary index that starts empty, then `git write-tree`.
 * The agent's own index, HEAD and branch are untouched, and `.gitignore` is respected. An index that
 * starts empty hashes every file, so no edit is missed for a timestamp.
 */
export const snapshot = Effect.fnUntraced(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem
  const index = join(repo, `.snapshot-index-${unique()}`)
  const env = { GIT_INDEX_FILE: index }
  const { work } = paths(repo)
  return yield* git(work, ["add", "-A", "--", ".", ...derived], env).pipe(
    Effect.andThen(git(work, ["write-tree"], env)),
    Effect.ensuring(Effect.ignore(fs.remove(index, { force: true }))),
  )
})

/**
 * Exports a tree to `repo/versions/<tree>/`, written under a temporary name and renamed once it is complete, so a kill
 * never leaves a half-written directory under a tree's name. `fresh` is false when the directory
 * was there already, which a failed check must then leave alone.
 */
export const exportTree = Effect.fnUntraced(function* (
  repo: string,
  tree: string,
) {
  const fs = yield* FileSystem.FileSystem
  const { work, versions } = paths(repo)
  const directory = join(versions, tree)
  if (yield* fs.exists(directory)) return { directory, fresh: false }
  yield* fs.makeDirectory(versions, { recursive: true })
  const temporary = join(versions, `.export-${tree}-${unique()}`)
  const index = join(repo, `.export-index-${unique()}`)
  const env = { GIT_INDEX_FILE: index }
  yield* git(work, ["read-tree", tree], env).pipe(
    Effect.andThen(
      git(work, ["checkout-index", "-a", `--prefix=${temporary}/`], env),
    ),
    Effect.ensuring(Effect.ignore(fs.remove(index, { force: true }))),
    Effect.tapError(() =>
      Effect.ignore(fs.remove(temporary, { recursive: true, force: true })),
    ),
  )
  // A tree with no file at all writes nothing, and its directory is still the tree.
  yield* fs.makeDirectory(temporary, { recursive: true })
  yield* fs.rename(temporary, directory)
  return { directory, fresh: true }
})

/** Repoints `repo/live` at a tree with a rename, so a reader sees the old tree or the new one. */
export const point = Effect.fnUntraced(function* (repo: string, tree: string) {
  const fs = yield* FileSystem.FileSystem
  const temporary = join(repo, `.live-${unique()}`)
  yield* fs.symlink(join("versions", tree), temporary)
  yield* fs.rename(temporary, paths(repo).live)
})

/** The tree `repo/live` names, or nothing. */
export const pointed = Effect.fnUntraced(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem
  const target = yield* Effect.option(fs.readLink(paths(repo).live))
  return Option.getOrUndefined(
    Option.map(target, (path) => path.split("/").pop()!),
  )
})

/** Deletes every exported tree but one, and whatever an export or a check left under `versions/`. */
export const prune = Effect.fnUntraced(function* (repo: string, keep: string) {
  const fs = yield* FileSystem.FileSystem
  const { versions } = paths(repo)
  const entries = yield* fs
    .readDirectory(versions)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  for (const entry of entries) {
    if (entry === keep) continue
    yield* Effect.ignore(
      fs.remove(join(versions, entry), { recursive: true, force: true }),
    )
  }
})

/**
 * A commit of a tree on the `applied` branch, with the previous applied commit as its parent. The message is the
 * `-m` text and the session that ran it is a trailer, so git alone holds both.
 */
export const commit = Effect.fnUntraced(function* (
  repo: string,
  options: {
    readonly tree: string
    readonly parent: string | undefined
    readonly message: string
    readonly session: string | undefined
  },
) {
  const { work } = paths(repo)
  const sha = yield* git(work, [
    "commit-tree",
    options.tree,
    ...(options.parent === undefined ? [] : ["-p", options.parent]),
    "-m",
    options.message,
    ...(options.session === undefined
      ? []
      : ["-m", `${sessionTrailer}: ${options.session}`]),
  ])
  yield* git(work, [
    "update-ref",
    `refs/heads/${applied}`,
    sha,
    ...(options.parent === undefined ? [] : [options.parent]),
  ])
  return sha
})

/**
 * Moves the branch in `work/` to an applied commit and keeps the files, so after an apply `git status` is clean and
 * `git diff` shows what is edited after it.
 */
export const reset = (repo: string, sha: string) =>
  git(paths(repo).work, ["reset", "-q", "--mixed", sha])

/**
 * The paths where a revert to `target` would write over something in `work/` that its save did not capture, such as
 * an ignored file: a path the target adds that `work/` already holds, or one of its parent directories that `work/`
 * holds as a file. This refuses the revert before its commit when what is in the way is there already.
 * It is not what keeps the files: `restore` writes over nothing, whenever a file appears.
 */
export const obstructed = Effect.fnUntraced(function* (
  repo: string,
  saved: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem
  const { work } = paths(repo)
  const fields = (yield* git(work, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--name-status",
    "--diff-filter=AD",
    saved,
    target,
  ])).split("\0")
  const added: Array<string> = []
  // The files of the save that the target deletes, which the revert may replace with a directory or a file.
  const deleted = new Set<string>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === "A") added.push(fields[i + 1]!)
    else deleted.add(fields[i + 1]!)
  }
  // A link counts as a file, as git counts it.
  const kind = (path: string) =>
    fs.lstat(join(work, path)).pipe(
      Effect.map((info) => (info.type === "Directory" ? "directory" : "file")),
      Effect.orElseSucceed(() => "absent" as const),
    )
  const found = new Set<string>()
  for (const path of added) {
    const parts = path.split("/")
    let blocked: string | undefined
    for (
      let depth = 1;
      depth <= parts.length && blocked === undefined;
      depth++
    ) {
      const prefix = parts.slice(0, depth).join("/")
      const held = yield* kind(prefix)
      if (held === "absent") break
      if (depth < parts.length) {
        // A parent that is a directory is where the file goes. One that is a file or a link is in the way, unless it
        // is a file of the save that the target deletes.
        if (held !== "directory" && !deleted.has(prefix)) blocked = prefix
      } else if (held !== "directory") {
        blocked = prefix
      } else {
        // A directory where the target puts a file is in the way when it holds anything but files of the save.
        const entries = yield* fs
          .readDirectory(join(work, prefix), { recursive: true })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => ["?"]))
        for (const entry of entries) {
          const inner = `${prefix}/${entry}`
          if (!deleted.has(inner) && (yield* kind(inner)) !== "directory") {
            blocked = prefix
            break
          }
        }
      }
    }
    if (blocked !== undefined) found.add(blocked)
  }
  return [...found]
})

/** What a revert's restore did with the files of `work/`. */
export interface Restored {
  /** The paths it did not put back, since what `work/` held there changed or appeared after the save. */
  readonly left: ReadonlyArray<string>
  /** The directory that holds, as they were, the files it moved out of `work/`, or nothing when it moved none. */
  readonly kept: string | undefined
}

/** One path that differs between the saved tree and the revert's, as `diff-tree --raw` gives it. */
interface Differs {
  readonly path: string
  readonly before: boolean
  readonly after: boolean
}

const absent = "000000"
const gitlink = "160000"

/** Where a revert keeps the files it moved out of `work/`, one directory per revert, named as its saved ref is. */
export const reverted = (repo: string, name: string) =>
  join(repo, "reverted", name)

/**
 * Puts the files of a revert's target back in `work/` and moves its branch to the commit. It deletes nothing that
 * `work/` held.
 *
 * The target's files, and the saved files as git would write them out, are first written to a directory of their own
 * under `repo/`. After that `work/` changes in three ways only:
 *
 * - What `work/` holds at a path the revert replaces or deletes is renamed into `repo/reverted/<name>/`. When its
 *   bytes are not those of the save, it is linked back to its path and left there. Otherwise it stays in that
 *   directory, as it was, and chad never deletes it. A write through a descriptor opened on it lands there too.
 * - A directory that those moves emptied is removed with `rmdir`, which fails on one that holds anything.
 * - A file of the target is linked into place, which fails where the path holds anything.
 *
 * None of these removes the last name of a file, so no bytes that `work/` held are lost, whenever a writer lands.
 */
export const restore = Effect.fnUntraced(function* (
  repo: string,
  options: {
    /** The commit the save made. */
    readonly saved: string
    /** The last part of the saved ref, which names the directory the moved files go to. */
    readonly name: string
    /** The revert's commit. */
    readonly sha: string
  },
) {
  const fs = yield* FileSystem.FileSystem
  const { work } = paths(repo)
  const directory = join(repo, `.restore-${unique()}`)
  const staged = join(directory, "new")
  const before = join(directory, "saved")
  const kept = reverted(repo, options.name)
  const stage = (tree: string, prefix: string, files: ReadonlyArray<string>) =>
    files.length === 0
      ? Effect.void
      : Effect.gen(function* () {
          const env = {
            GIT_DIR: join(work, ".git"),
            GIT_WORK_TREE: work,
            GIT_INDEX_FILE: join(directory, `index-${unique()}`),
          }
          yield* git(work, ["read-tree", tree], env)
          yield* git(
            work,
            ["checkout-index", `--prefix=${prefix}/`, "--", ...files],
            env,
          )
        })
  const fields = (yield* git(work, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    options.saved,
    options.sha,
  ])).split("\0")
  const entries: Array<Differs> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [from, to] = fields[i]!.slice(1).split(" ")
    // A submodule is not a file of work/, and the save never holds one.
    if (from === gitlink || to === gitlink) continue
    entries.push({
      path: fields[i + 1]!,
      before: from !== absent,
      after: to !== absent,
    })
  }
  const placed = entries.filter(({ after }) => after).map(({ path }) => path)
  const held = entries.filter(({ before }) => before).map(({ path }) => path)
  const left = new Set<string>()
  let moved = 0

  /** Whether a moved file holds the bytes git writes out for the save, or is the link the save holds. */
  const same = (path: string) =>
    Effect.gen(function* () {
      const file = join(kept, path)
      const saved = join(before, path)
      const [info, expected] = yield* Effect.all([
        fs.lstat(file),
        fs.lstat(saved),
      ])
      if (info.type === "SymbolicLink" || expected.type === "SymbolicLink") {
        return (
          info.type === expected.type &&
          (yield* fs.readLink(file)) === (yield* fs.readLink(saved))
        )
      }
      if (info.type !== "File" || expected.type !== "File") return false
      const [a, b] = (yield* git(work, [
        "hash-object",
        "--no-filters",
        "--",
        file,
        saved,
      ])).split("\n")
      return a !== undefined && a === b
    }).pipe(Effect.orElseSucceed(() => false))

  yield* Effect.gen(function* () {
    // Nothing in work/ changes until both are written, so a failure here leaves it as it was.
    yield* fs.makeDirectory(staged, { recursive: true })
    yield* stage(options.sha, staged, placed)
    yield* stage(options.saved, before, held)

    const vacated: Array<string> = []
    for (const path of held) {
      const file = join(work, path)
      const info = yield* Effect.option(fs.lstat(file))
      if (info._tag === "None") continue
      if (info.value.type === "Directory") {
        left.add(path)
        continue
      }
      yield* fs.makeDirectory(dirname(join(kept, path)), { recursive: true })
      if (!(yield* Effect.isSuccess(fs.rename(file, join(kept, path))))) {
        left.add(path)
        continue
      }
      moved++
      if (yield* same(path)) {
        vacated.push(path)
        continue
      }
      // Changed since the save: it goes back to its path, and the other name goes once that one is there.
      left.add(path)
      if (yield* Effect.isSuccess(fs.link(join(kept, path), file))) {
        yield* fs.remove(join(kept, path))
        moved--
      }
    }
    // A directory that the moves emptied goes, so a file of the target can take its name.
    const parents = new Set<string>()
    for (const path of vacated) {
      for (let at = dirname(path); at !== "."; at = dirname(at)) parents.add(at)
    }
    for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
      yield* Effect.ignore(Effect.tryPromise(() => rmdir(join(work, parent))))
    }
    // The target's files, each linked in only where its path is free.
    for (const path of placed) {
      if (left.has(path)) continue
      const file = join(work, path)
      const linked = yield* Effect.isSuccess(
        fs
          .makeDirectory(dirname(file), { recursive: true })
          .pipe(Effect.andThen(fs.link(join(staged, path), file))),
      )
      if (!linked) left.add(path)
    }
  }).pipe(
    // Staging failed before work/ was touched, or a step failed part way. What was not put back counts as left, and
    // what was moved stays where it is.
    Effect.catch(() =>
      Effect.sync(() => {
        for (const path of placed) left.add(path)
      }),
    ),
    Effect.ensuring(
      Effect.ignore(fs.remove(directory, { recursive: true, force: true })),
    ),
  )
  // The directories made for moves that did not happen, or whose file went back, go, and only while they are empty.
  if (moved === 0) yield* removeEmpty(kept)
  yield* reset(repo, options.sha)
  return {
    left: [...left].sort(),
    kept: (yield* fs.exists(kept)) ? kept : undefined,
  } satisfies Restored
})

/** Removes a directory and the directories under it with `rmdir`, so a directory that holds a file stays. */
const removeEmpty = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs
      .readDirectory(directory, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
    for (const entry of [...entries].sort((a, b) => b.length - a.length)) {
      yield* Effect.ignore(
        Effect.tryPromise(() => rmdir(join(directory, entry))),
      )
    }
    yield* Effect.ignore(Effect.tryPromise(() => rmdir(directory)))
  })

/**
 * Saves what `work/` holds as a commit under `refs/chad/saved/<timestamp>`, from the same snapshot an apply takes, so
 * it keeps untracked files and respects `.gitignore`. It gives the ref, the saved tree and the commit.
 */
export const save = Effect.fnUntraced(function* (repo: string) {
  const { work } = paths(repo)
  const tree = yield* snapshot(repo)
  const parent = yield* git(work, ["rev-parse", "-q", "--verify", "HEAD"]).pipe(
    Effect.orElseSucceed(() => ""),
  )
  const sha = yield* git(work, [
    "commit-tree",
    tree,
    ...(parent === "" ? [] : ["-p", parent]),
    "-m",
    "Saved by chad revert",
  ])
  const ref = `refs/chad/saved/${new Date().toISOString().replace(/[:.]/g, "-")}-${unique().slice(0, 4)}`
  yield* git(work, ["update-ref", ref, sha])
  return { ref, tree, commit: sha }
})

/** The commit a revert goes back to, or the reason there is none. */
export const target = Effect.fnUntraced(function* (
  repo: string,
  current: string,
  commit: string | undefined,
) {
  const { work } = paths(repo)
  if (commit === undefined) {
    const parent = yield* git(work, [
      "rev-parse",
      "-q",
      "--verify",
      `${current}^1`,
    ]).pipe(Effect.orElseSucceed(() => ""))
    return parent === "" ? undefined : parent
  }
  const sha = yield* git(work, [
    "rev-parse",
    "-q",
    "--verify",
    `${commit}^{commit}`,
  ]).pipe(Effect.orElseSucceed(() => ""))
  if (sha === "") return undefined
  const on = yield* Effect.isSuccess(
    git(work, ["merge-base", "--is-ancestor", sha, current]),
  )
  return on ? sha : undefined
})

/** The files that differ between two trees, as `git diff --name-status` lists them. */
export const changed = (repo: string, from: string | undefined, to: string) =>
  git(paths(repo).work, [
    "diff-tree",
    "-r",
    "--name-status",
    "--no-renames",
    from ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    to,
  ]).pipe(
    Effect.map((text) =>
      text === ""
        ? []
        : text.split("\n").map((line) => {
            const [status, ...rest] = line.split("\t")
            return { status: status!, path: rest.join("\t") }
          }),
    ),
  )

/** One applied commit as `chad log` shows it. */
export interface Entry {
  readonly commit: string
  readonly time: string
  readonly session: string
  readonly message: string
}

/** The newest applied commits, read from the commits alone, so it needs no daemon and no database. */
export const log = Effect.fnUntraced(function* (repo: string, limit: number) {
  const { work } = paths(repo)
  const text = yield* git(work, [
    "log",
    `refs/heads/${applied}`,
    `-n${limit}`,
    `--format=%H%x1f%cI%x1f%(trailers:key=${sessionTrailer},valueonly,separator=%x2c)%x1f%s%x1e`,
  ])
  return text
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .map((record): Entry => {
      const [commit, time, session, message] = record.split("\x1f")
      return {
        commit: commit!,
        time: time!,
        session: session?.trim() || "terminal",
        message: message ?? "",
      }
    })
})

/**
 * Makes the repo when `work/` has none: `git init` on the branch `main`, chad's identity in the repo's own config,
 * and a first commit of `chad.json` as `{ "plugins": {} }` and an empty `persona.md`, which is also the head of
 * `applied`. A repo that has `work/` but no `applied` branch gets one at its own
 * first commit of the files it holds.
 */
const create = Effect.fnUntraced(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem
  const { work } = paths(repo)
  yield* fs.makeDirectory(work, { recursive: true })
  if (!(yield* fs.exists(join(work, ".git")))) {
    yield* git(work, ["init", "-q", "-b", main])
    yield* git(work, ["config", "user.name", identity.name])
    yield* git(work, ["config", "user.email", identity.email])
    if (!(yield* fs.exists(join(work, "chad.json")))) {
      yield* fs.writeFileString(
        join(work, "chad.json"),
        `${JSON.stringify({ plugins: {} }, null, 2)}\n`,
      )
    }
    if (!(yield* fs.exists(join(work, "persona.md")))) {
      yield* fs.writeFileString(join(work, "persona.md"), "")
    }
  }
  const tree = yield* snapshot(repo)
  const sha = yield* commit(repo, {
    tree,
    parent: undefined,
    message: "First commit",
    session: undefined,
  })
  yield* reset(repo, sha)
  return sha
})

/**
 * The repo as a boot needs it: the repo with its first commit when there is none,
 * and `live` naming the tree of the head of `applied`, exported first when `versions/` does not hold it. The head of
 * `applied` wins over what `live` named, and the other entries of `versions/` go. It gives the loaded tree.
 */
export const prepare = Effect.fnUntraced(function* (repo: string) {
  const { work } = paths(repo)
  const sha = (yield* head(work)) ?? (yield* create(repo))
  const tree = yield* treeOf(work, sha)
  const { directory } = yield* exportTree(repo, tree)
  if ((yield* pointed(repo)) !== tree) yield* point(repo, tree)
  yield* prune(repo, tree)
  return { sha, tree, directory }
})

/**
 * What `chad status` shows of the repo, read from it alone: the applied commit, and whether `work/` holds a draft,
 * which is a file that differs from the applied commit. A repo that cannot be read gives neither.
 */
export const state = (repo: string) =>
  Effect.gen(function* () {
    const { work } = paths(repo)
    const sha = yield* head(work)
    if (sha === undefined) return { applied: undefined, draft: undefined }
    const message = yield* git(work, ["log", "-1", "--format=%s", sha])
    const changed = yield* git(work, ["diff", "--name-only", sha, "--"])
    const untracked = yield* git(work, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ".",
      ...derived,
    ])
    return {
      applied: { commit: sha.slice(0, 7), message },
      draft: changed !== "" || untracked !== "",
    }
  }).pipe(
    Effect.orElseSucceed(() => ({ applied: undefined, draft: undefined })),
  )
