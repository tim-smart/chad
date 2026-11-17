/**
 * The npm packages of the repo's plugins. `work/package.json` names them and `work/package-lock.json` pins them, both
 * committed with the code. chad installs what a tree's lockfile says under `repo/packages/<hash>/`, named by the hash
 * of the lockfile, and links it into the exported tree as `node_modules`, so `tsc` and esbuild find a plugin's
 * packages by walking up from its file. The installs are derived state, like `repo/versions/`: no backup holds them,
 * and a boot or an apply installs again what is missing.
 *
 * chad and its direct dependencies, effect among them, are the host's. An install never keeps a copy of one, so a
 * package that imports effect, as a dependency or a peer dependency, gets the host's at run time and in the type-check.
 */
import { createHash, randomBytes } from "node:crypto"
import { join } from "node:path"
import {
  Data,
  Duration,
  Effect,
  FileSystem,
  Option,
  Schema,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as semver from "semver"
import * as Messages from "../Messages.ts"
import * as Version from "../Version.ts"
import * as Logger from "./Logger.ts"
import { modules } from "./RepoLinks.ts"

/** A tree's packages that cannot be made ready, with the text the owner and the agent read. */
export class PackagesError extends Data.TaggedError("PackagesError")<{
  readonly message: string
}> {}

export const manifestName = "package.json"
export const lockName = "package-lock.json"

const Ranges = Schema.Record(Schema.String, Schema.String)

/** The fields of a manifest that name packages, which the lockfile's root entry repeats. */
const fields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

const Manifest = Schema.Struct({
  type: Schema.optionalKey(Schema.Unknown),
  dependencies: Schema.optionalKey(Ranges),
  devDependencies: Schema.optionalKey(Ranges),
  optionalDependencies: Schema.optionalKey(Ranges),
  peerDependencies: Schema.optionalKey(Ranges),
})

const Entry = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  link: Schema.optionalKey(Schema.Boolean),
  dependencies: Schema.optionalKey(Ranges),
  devDependencies: Schema.optionalKey(Ranges),
  optionalDependencies: Schema.optionalKey(Ranges),
  peerDependencies: Schema.optionalKey(Ranges),
})
type Entry = typeof Entry.Type

/** A lockfile of npm 7 or later. An older one has no `packages` and is read as stale. */
const Lock = Schema.Struct({
  lockfileVersion: Schema.Number,
  packages: Schema.Record(Schema.String, Entry),
})
type Lock = typeof Lock.Type

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Manifest),
)
const decodeLock = Schema.decodeUnknownEffect(Schema.fromJsonString(Lock))

/** What a tree holds: no packages, or a lockfile that passed its checks. */
export type Found =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Lock"
      /** The name of its install. */
      readonly hash: string
      readonly manifest: string
      readonly lock: string
      readonly packages: Lock["packages"]
    }

const none: Found = { _tag: "None" }

const host: ReadonlySet<string> = new Set(Version.hostPackages)

/** The package an entry of the lockfile installs, which is the last name in its path. */
const nameOf = (key: string, entry?: Entry) =>
  entry?.name ??
  key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)

const same = (
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
) => {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))
  const right = Object.entries(b ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))
  return JSON.stringify(left) === JSON.stringify(right)
}

/** The version of each host package as it is installed beside chad. One that cannot be read is left out. */
const hostVersions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const versions = new Map<string, string>([["chad", Version.version]])
  for (const name of host) {
    if (name === "chad") continue
    const text = yield* Effect.option(
      fs.readFileString(join(modules, name, "package.json")),
    )
    if (Option.isNone(text)) continue
    const version = Option.getOrUndefined(
      Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
      )(text.value),
    )?.version
    if (version !== undefined) versions.set(name, version)
  }
  return versions
})

/**
 * Every range in the lockfile on a host package that the host's version does not satisfy, as a line that names the
 * package that asks for it. The host's copy is the one every package gets, so such a package would run on a version it
 * does not support. A range that is not a semver range, such as a URL, is not judged.
 */
const conflicts = Effect.fnUntraced(function* (packages: Lock["packages"]) {
  const versions = yield* hostVersions
  const lines: Array<string> = []
  for (const [key, entry] of Object.entries(packages)) {
    if (entry.link === true) continue
    // A host package's own copy is never installed, so what it asks for does not matter.
    if (key !== "" && host.has(nameOf(key, entry))) continue
    const asking =
      key === ""
        ? "work/package.json"
        : `${nameOf(key, entry)}@${entry.version ?? "?"}`
    for (const field of key === ""
      ? fields
      : ([
          "dependencies",
          "optionalDependencies",
          "peerDependencies",
        ] as const)) {
      for (const [name, range] of Object.entries(entry[field] ?? {})) {
        const version = versions.get(name)
        if (version === undefined || semver.validRange(range) === null) continue
        if (!semver.satisfies(version, range, { includePrerelease: true })) {
          lines.push(Messages.hostConflictLine(asking, name, range, version))
        }
      }
    }
  }
  return [...new Set(lines)]
})

/** A file's text, or nothing when it is missing. */
const optionalText = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(error),
    ),
  )
})

/**
 * The packages of a tree, checked: `package.json` is a module, the lockfile is there and matches it, and nothing in it
 * needs a version of a host package that the host does not have. A tree with no `package.json`, or one that names no
 * package, has none.
 */
export const read = Effect.fnUntraced(function* (tree: string) {
  const fail = (message: string) => Effect.fail(new PackagesError({ message }))
  const manifestText = yield* optionalText(join(tree, manifestName)).pipe(
    Effect.catchTag("PlatformError", (error) =>
      fail(Messages.manifestUnreadable(error.message)),
    ),
  )
  if (Option.isNone(manifestText)) return none
  const manifest = yield* decodeManifest(manifestText.value).pipe(
    Effect.catchTag("SchemaError", (error) =>
      fail(Messages.manifestUnreadable(Messages.firstLine(error.message))),
    ),
  )
  if (manifest.type !== "module") return yield* fail(Messages.manifestNotModule)
  const declared = fields.some(
    (field) => Object.keys(manifest[field] ?? {}).length > 0,
  )
  const lockText = yield* optionalText(join(tree, lockName)).pipe(
    Effect.catchTag("PlatformError", (error) =>
      fail(Messages.manifestUnreadable(error.message)),
    ),
  )
  if (Option.isNone(lockText)) {
    return declared ? yield* fail(Messages.lockMissing) : none
  }
  const lock = yield* decodeLock(lockText.value).pipe(
    Effect.catchTag("SchemaError", () => fail(Messages.lockStale)),
  )
  const root = lock.packages[""] ?? {}
  if (fields.some((field) => !same(manifest[field], root[field]))) {
    return yield* fail(Messages.lockStale)
  }
  if (!declared) return none
  const problems = yield* conflicts(lock.packages)
  if (problems.length > 0) return yield* fail(Messages.hostConflict(problems))
  const hash = createHash("sha256")
    .update(lockText.value)
    .update("\0")
    // An install leaves out the host's packages, so a chad with other direct dependencies installs again.
    .update(Version.hostPackages.join(","))
    .digest("hex")
    .slice(0, 16)
  return {
    _tag: "Lock",
    hash,
    manifest: manifestText.value,
    lock: lockText.value,
    packages: lock.packages,
  } satisfies Found as Found
})

/** The packages a lockfile puts at the top of `node_modules`, which a plugin can import, by name, with the version. */
export const topLevel = (found: Found): ReadonlyMap<string, string> =>
  found._tag === "None"
    ? new Map()
    : new Map(
        Object.entries(found.packages).flatMap(([key, entry]) => {
          const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key)
          return match === null || host.has(match[1]!) || entry.link === true
            ? []
            : [[match[1]!, entry.version ?? "?"] as const]
        }),
      )

/** The lines of a check or an apply about the packages it adds, removes and changes. */
export const changes = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
) =>
  Messages.packageChanges({
    added: [...after].filter(([name]) => !before.has(name)),
    removed: [...before].filter(([name]) => !after.has(name)),
    changed: [...after].flatMap(([name, version]) => {
      const was = before.get(name)
      return was === undefined || was === version
        ? []
        : [[name, was, version] as const]
    }),
  })

const unique = () => randomBytes(6).toString("hex")

/** The lines of npm's output that say why it failed, at most 10. */
const npmLines = (output: string) => {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
  const errors = lines.filter((line) => line.startsWith("npm error"))
  return (errors.length > 0 ? errors : lines).slice(0, 10)
}

/** What a tree's packages came to: the install it is linked to, whether this call installed it, and its packages. */
export interface Ready {
  readonly hash: string | undefined
  readonly installed: boolean
  readonly packages: ReadonlyMap<string, string>
}

type Services = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

export interface Packages {
  /**
   * Makes a tree's packages ready: checked, installed when no install of its lockfile is there, and linked into the
   * tree as `node_modules`. A tree with no packages has no link.
   */
  readonly ready: (
    tree: string,
  ) => Effect.Effect<Ready, PackagesError, Services>
  /** Deletes every install but the one named, and whatever an install that did not finish left. */
  readonly prune: (
    keep: string | undefined,
  ) => Effect.Effect<void, never, FileSystem.FileSystem>
}

export const make = (options: {
  readonly repo: string
  /** npm's cache, `NPM_CONFIG_CACHE` and `cache/npm` on the volume without it. */
  readonly cache: string
  /** The longest an install runs. */
  readonly deadline: Duration.Duration
  /** How long npm has to end after a SIGTERM before it gets a SIGKILL. */
  readonly stop: Duration.Duration
}): Packages => {
  const root = join(options.repo, "packages")

  /** Runs npm in a directory and gives what it printed and its exit code. */
  const npm = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const handle = yield* spawner.spawn(
          ChildProcess.make("npm", args, {
            cwd,
            forceKillAfter: options.stop,
            extendEnv: true,
            env: { npm_config_update_notifier: "false" },
          }),
        )
        return yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
          { concurrency: 2 },
        )
      }),
    )

  /**
   * Installs a lockfile under a temporary name and renames it to its hash once it is complete, so a kill or a full disk
   * never leaves a directory under a hash that holds part of an install. Lifecycle scripts never run. It gives whether
   * it installed, which it does not when the install is there already.
   */
  const install = Effect.fnUntraced(function* (
    found: Extract<Found, { _tag: "Lock" }>,
  ) {
    const fs = yield* FileSystem.FileSystem
    const target = join(root, found.hash)
    if (yield* fs.exists(target)) return false
    const temporary = join(root, `.install-${found.hash}-${unique()}`)
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(temporary, { recursive: true })
      yield* fs.writeFileString(join(temporary, manifestName), found.manifest)
      yield* fs.writeFileString(join(temporary, lockName), found.lock)
      const [output, code] = yield* npm(temporary, [
        "ci",
        "--ignore-scripts",
        "--include=dev",
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--cache",
        options.cache,
      ]).pipe(
        Effect.timeoutOrElse({
          duration: options.deadline,
          orElse: () =>
            Effect.fail(
              new PackagesError({
                message: Messages.installTimedOut(
                  Duration.toSeconds(options.deadline),
                ),
              }),
            ),
        }),
      )
      if (code !== 0) {
        return yield* new PackagesError({
          message: Messages.installFailed(npmLines(output)),
        })
      }
      // The host's packages resolve past the install, to the host's own copy.
      for (const [key, entry] of Object.entries(found.packages)) {
        if (key !== "" && host.has(nameOf(key, entry))) {
          yield* fs.remove(join(temporary, key), {
            recursive: true,
            force: true,
          })
        }
      }
      yield* fs.makeDirectory(join(temporary, "node_modules"), {
        recursive: true,
      })
      yield* fs.rename(temporary, target)
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new PackagesError({
            message: Messages.installFailed([error.message]),
          }),
        ),
      ),
      Effect.onError(() =>
        Effect.ignore(fs.remove(temporary, { recursive: true, force: true })),
      ),
    )
    return true
  })

  /** Points the tree's `node_modules` at an install, or takes it away, with a rename so a reader sees one or the other. */
  const link = Effect.fnUntraced(function* (
    tree: string,
    hash: string | undefined,
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = join(tree, "node_modules")
    const target =
      hash === undefined
        ? undefined
        : join("..", "..", "packages", hash, "node_modules")
    const current = yield* Effect.option(fs.readLink(path))
    if (Option.isSome(current) && current.value === target) return
    // Whatever else is there is derived, a link to another install or a directory an older export holds, and goes.
    if (target === undefined || Option.isNone(current)) {
      yield* fs.remove(path, { recursive: true, force: true })
    }
    if (target === undefined) return
    const temporary = join(tree, `.node_modules-${unique()}`)
    yield* fs.symlink(target, temporary)
    yield* fs.rename(temporary, path)
  })

  const ready = (tree: string) =>
    Effect.gen(function* () {
      const found = yield* read(tree)
      if (found._tag === "None") {
        yield* link(tree, undefined)
        return { hash: undefined, installed: false, packages: new Map() }
      }
      const installed = yield* install(found)
      yield* link(tree, found.hash)
      const packages = topLevel(found)
      if (installed) {
        yield* Logger.event(
          "packages.installed",
          "The packages of a lockfile were installed",
          { hash: found.hash, packages: packages.size },
        )
      }
      return { hash: found.hash, installed, packages } satisfies Ready as Ready
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new PackagesError({
            message: Messages.installFailed([error.message]),
          }),
        ),
      ),
      Effect.tapError((error) =>
        Logger.event("packages.failed", "A tree's packages are not ready", {
          tree,
          error: error.message.slice(0, 4000),
        }),
      ),
    )

  const prune = (keep: string | undefined) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const entries = yield* fs
        .readDirectory(root)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
      for (const entry of entries) {
        if (entry === keep) continue
        yield* Effect.ignore(
          fs.remove(join(root, entry), { recursive: true, force: true }),
        )
      }
    })

  return { ready, prune }
}

/** What `topLevel` reads from a tree, for the lines of a change: nothing when it has no packages or cannot be read. */
export const listed = (tree: string | undefined) =>
  tree === undefined
    ? Effect.succeed<ReadonlyMap<string, string>>(new Map())
    : read(tree).pipe(
        Effect.map(topLevel),
        Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()),
      )
