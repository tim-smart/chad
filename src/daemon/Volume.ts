import { join } from "node:path"
import { Context, Effect, FileSystem, Option } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"

/** The paths of the data volume. */
export interface Volume {
  readonly data: string
  readonly database: string
  readonly repo: string
  readonly sessions: string
  /** `$HOME` of every session, for work that should outlast one. */
  readonly home: string
  readonly version: string
  readonly log: string
  /** The daemon lock's file. */
  readonly lock: string
  /** The unix socket the CLI reaches the daemon on. */
  readonly socket: string
  /** The fixed path at which the local adapter looks for its chat platform. */
  readonly localSocket: string
}

export const Volume = Context.Service<Volume>("chad/Volume")

export const make = (
  data: string,
  socket: string = join(data, "run/chad.sock"),
): Volume => ({
  data,
  lock: Paths.lock(data),
  socket,
  database: Paths.database(data),
  repo: join(data, "repo"),
  sessions: join(data, "sessions"),
  home: join(data, "home"),
  version: Paths.version(data),
  log: Paths.log(data),
  localSocket: join(data, "run/local.sock"),
})

/**
 * The directories `chad serve` creates when it finds them missing, with the mode of the two that are private.
 * `state/` and `logs/` are not here: the first is made when the lock is taken and the second with the log file.
 */
const directories: ReadonlyArray<readonly [name: string, mode?: number]> = [
  ["db"],
  ["secrets", 0o700],
  ["run", 0o700],
  ["sessions"],
  ["home"],
  ["cache"],
]

const ownership = (info: FileSystem.File.Info): Messages.Ownership => ({
  uid: Option.getOrThrow(info.uid),
  gid: Option.getOrThrow(info.gid),
  mode: (info.mode & 0o7777).toString(8),
})

/**
 * The start-up check. It writes nothing, and gives the exit message when the volume is missing, cannot be written or
 * holds a `repo/` that another uid owns.
 */
export const check = Effect.fnUntraced(function* (
  volume: Volume,
): Effect.fn.Return<string | undefined, PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const self = { uid: process.getuid!(), gid: process.getgid!() }
  // `.` is looked up inside the directory, so the one call asks for the right to search it as well as to write it.
  const refused = yield* fs.access(`${volume.data}/.`, { writable: true }).pipe(
    Effect.as(undefined),
    Effect.catchTag("PlatformError", (error) => Effect.succeed(error)),
  )
  if (refused !== undefined) {
    return refused.reason._tag === "NotFound"
      ? Messages.dataMissing(volume.data)
      : Messages.dataNotWritable(
          volume.data,
          self,
          ownership(yield* fs.stat(volume.data)),
        )
  }
  const repo = yield* fs
    .stat(volume.repo)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.undefined
          : Effect.fail(error),
      ),
    )
  return repo !== undefined && Option.getOrThrow(repo.uid) !== self.uid
    ? Messages.repoNotOwned(volume.repo, self.uid, ownership(repo))
    : undefined
})

/**
 * Creates the directories that are missing. The private ones get their mode from a chmod, on every start, because
 * chad never changes the process umask.
 */
export const prepare = Effect.fnUntraced(function* (
  volume: Volume,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  for (const [name, mode] of directories) {
    const path = join(volume.data, name)
    yield* fs.makeDirectory(path, { recursive: true })
    if (mode !== undefined) yield* fs.chmod(path, mode)
  }
})
