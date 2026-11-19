import { backup, DatabaseSync } from "node:sqlite"
import { Data, Effect, FileSystem, Result, SemVer } from "effect"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import { version } from "../Version.ts"
import type { Volume } from "./Volume.ts"

/**
 * What a boot does about the chad version that last wrote the volume: the refusal of a newer one, and the copy of the
 * database taken before a new image migrates it.
 */

class CopyFailed extends Data.TaggedError("CopyFailed")<{
  readonly message: string
}> {}

/** What a file holds, trimmed, or nothing when there is no file. Any other failure to read it is an error. */
const readText = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(
    Effect.map((text): string | undefined => text.trim()),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(error),
    ),
  )

/** Whether `text` names a chad newer than this one. Text that is no version counts as newer, as the CLI reads it. */
const isNewer = (text: string) => {
  const parsed = SemVer.parse(text)
  return (
    Result.isFailure(parsed) ||
    SemVer.isGreaterThan(parsed.success, SemVer.parseUnsafe(version))
  )
}

/**
 * The check that runs right after the lock is taken: the exit message when `state/version` names a newer chad, or
 * nothing. It only reads, so a boot it refuses has written nothing on the volume but its log lines.
 */
export const newer = Effect.fnUntraced(function* (data: string) {
  const fs = yield* FileSystem.FileSystem
  const volume = yield* readText(fs, Paths.version(data))
  if (volume === undefined || !isNewer(volume)) return undefined
  const path = Paths.beforeMigration(data)
  const copied = yield* fs.exists(path)
  return Messages.volumeNewer({
    data,
    volume,
    own: version,
    copy: copied
      ? {
          path,
          version: yield* readText(fs, Paths.beforeMigrationVersion(data)),
        }
      : undefined,
  })
})

export interface Copied {
  /** What `state/version` held before this boot, or nothing on a volume that has no such file. */
  readonly previous: string | undefined
  /** The copy this boot took, or nothing when it took none. */
  readonly copy: string | undefined
}

/**
 * Copies the database before the migrations when this is the first boot of a new image: the database existed before
 * this boot opened it and
 * `state/version` is older or absent. A boot that finds `state/migrating` takes no copy, because the one in place is
 * the database from before the migration that did not finish.
 *
 * The copy is SQLite's stepped online backup, so the socket goes on answering, and it is written under a temporary name
 * and renamed once complete. The version beside it is removed before the copy is renamed and written after, so a kill
 * between the two never pairs a copy with another copy's version.
 */
export const copy = Effect.fnUntraced(function* (
  volume: Volume,
  existed: boolean,
) {
  const fs = yield* FileSystem.FileSystem
  const previous = yield* readText(fs, volume.version)
  const none: Copied = { previous, copy: undefined }
  if (!existed) return none
  if (
    previous !== undefined &&
    !SemVer.isLessThan(
      SemVer.parseUnsafe(previous),
      SemVer.parseUnsafe(version),
    )
  ) {
    return none
  }
  if (yield* fs.exists(Paths.migrating(volume.data))) return none
  const path = Paths.beforeMigration(volume.data)
  const beside = Paths.beforeMigrationVersion(volume.data)
  const partial = `${path}.partial`
  yield* fs.remove(partial, { force: true })
  yield* Effect.tryPromise({
    try: async () => {
      const source = new DatabaseSync(volume.database, { readOnly: true })
      try {
        await backup(source, partial)
      } finally {
        source.close()
      }
    },
    catch: (error) => new CopyFailed({ message: String(error) }),
  })
  yield* fs.writeFileString(`${beside}.partial`, `${previous ?? ""}\n`)
  yield* fs.remove(beside, { force: true })
  yield* fs.rename(partial, path)
  yield* fs.rename(`${beside}.partial`, beside)
  yield* fs.writeFileString(Paths.migrating(volume.data), `${version}\n`)
  return { previous, copy: path } satisfies Copied
})

/** Writes `state/version` after the migrations, then removes `state/migrating`. */
export const written = Effect.fnUntraced(function* (volume: Volume) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(volume.version, version + "\n")
  yield* fs.remove(Paths.migrating(volume.data), { force: true })
})
