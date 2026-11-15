import { accessSync, chmodSync, constants, mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { Context } from "effect"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"

/** The paths of the data volume, as the tree in docs/spec/01-image-and-volume.md lays them out. */
export interface Volume {
  readonly data: string
  readonly database: string
  readonly repo: string
  readonly sessions: string
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
  version: Paths.version(data),
  log: join(data, "logs/chad.log"),
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

const ownership = (path: string): Messages.Ownership => {
  const stat = statSync(path)
  return {
    uid: stat.uid,
    gid: stat.gid,
    mode: (stat.mode & 0o7777).toString(8),
  }
}

/**
 * The start-up check. It writes nothing, and gives the exit message when the volume is missing, cannot be written or
 * holds a `repo/` that another uid owns.
 */
export const check = (volume: Volume): string | undefined => {
  const self = { uid: process.getuid!(), gid: process.getgid!() }
  try {
    accessSync(volume.data, constants.W_OK | constants.X_OK)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? Messages.dataMissing(volume.data)
      : Messages.dataNotWritable(volume.data, self, ownership(volume.data))
  }
  const repo = statSync(volume.repo, { throwIfNoEntry: false })
  return repo !== undefined && repo.uid !== self.uid
    ? Messages.repoNotOwned(volume.repo, self.uid, ownership(volume.repo))
    : undefined
}

/**
 * Creates the directories that are missing. The private ones get their mode from a chmod, on every start, because
 * chad never changes the process umask.
 */
export const prepare = (volume: Volume): void => {
  for (const [name, mode] of directories) {
    const path = join(volume.data, name)
    mkdirSync(path, { recursive: true })
    if (mode !== undefined) chmodSync(path, mode)
  }
}
