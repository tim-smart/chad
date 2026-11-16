import { dirname } from "node:path"
import { Duration, Effect, FileSystem, Result, SemVer } from "effect"
import * as Errno from "../Errno.ts"
import * as Lock from "../Lock.ts"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import { Timings } from "../Timings.ts"
import { version } from "../Version.ts"
import { Environment } from "./Environment.ts"
import { ExitCode, Failure } from "./Failure.ts"

/** What a command that writes files on the volume does when no daemon runs. */

/**
 * Whether this CLI may write to the volume. It may not when the data directory is missing, and not when
 * `state/version` names a newer chad, by semver precedence. A volume no `chad serve` has written yet has no such
 * file and takes the write.
 */
export const writable = Effect.fn("Files.writable")(function* (
  command: string,
) {
  const environment = yield* Environment
  const fs = yield* FileSystem.FileSystem
  const failed = (message: string) =>
    new Failure({ code: ExitCode.failed, message })
  const present = yield* fs
    .exists(environment.data)
    .pipe(Effect.catch(() => Effect.succeed(false)))
  if (!present) {
    return yield* failed(Messages.volumeMissing(command, environment.data))
  }
  if (yield* fs.exists(Paths.restoreCut(environment.data)).pipe(Effect.orDie)) {
    return yield* failed(Messages.restoreUnfinished(command, environment.data))
  }
  const path = Paths.version(environment.data)
  const read = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(
              failed(Messages.unreadable(command, path, Errno.code(error))),
            ),
      ),
    )
  if (read === undefined) return
  const text = read.trim()
  const volume = SemVer.parse(text)
  if (Result.isFailure(volume)) {
    // What the file holds is no version, so nothing says this CLI is new enough.
    return yield* failed(Messages.cliOlder(command, version, text))
  }
  if (SemVer.isLessThan(SemVer.parseUnsafe(version), volume.success)) {
    return yield* failed(Messages.cliOlder(command, version, text))
  }
})

/**
 * Takes the daemon lock for a write with no daemon, and gives its release. It fails when a daemon holds the lock, and
 * when a `chad restore` left the volume half replaced, which is checked again under the lock because the restore may
 * have been cut while this command waited on something before its write (STO-217). The lock is released on a refusal. The lock's directory exists already.
 * `started` is what the command says when a daemon holds the lock.
 */
export const take = Effect.fnUntraced(function* (
  command: string,
  started = Messages.daemonStarted(command),
) {
  const environment = yield* Environment
  const fs = yield* FileSystem.FileSystem
  const release = Lock.take(environment.lock, Duration.zero)
  if (release === undefined) {
    return yield* new Failure({ code: ExitCode.failed, message: started })
  }
  const cut = yield* fs.exists(Paths.restoreCut(environment.data)).pipe(
    Effect.orDie,
    Effect.onError(() => Effect.sync(release)),
  )
  if (cut) {
    release()
    return yield* new Failure({
      code: ExitCode.failed,
      message: Messages.restoreUnfinished(command, environment.data),
    })
  }
  return release
})

/**
 * Runs a write while this CLI holds the daemon lock, so no daemon can start between the lock test and the write and
 * miss the change. The lock is taken only now, after anything the command waited on. A daemon that started in the
 * meantime holds it, and the command then fails and writes nothing.
 * Interruption waits for the write: submitted native file operations cannot be cancelled, so releasing the lock
 * before they finish would let a new daemon read stale files.
 */
export const locked = <A, E, R>(
  command: string,
  write: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Failure, R | Environment | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const environment = yield* Environment
    const fs = yield* FileSystem.FileSystem
    yield* Effect.orDie(
      fs.makeDirectory(dirname(environment.lock), { recursive: true }),
    )
    return yield* Effect.gen(function* () {
      const release = yield* take(command)
      return yield* Effect.ensuring(write, Effect.sync(release))
    }).pipe(Effect.uninterruptible)
  })

/**
 * Runs a write to `repo/work` that a command makes whether or not a daemon runs, such as a starter file. It holds the
 * restore lock, so no `chad restore` begins to replace the volume between its check of `restore.installing` and its
 * write, and a daemon that stops meanwhile changes nothing. A volume a cut restore left is refused (STO-217, STO-219).
 */
export const scaffold = <A, E, R>(
  command: string,
  write: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Failure, R | Environment | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const environment = yield* Environment
    const fs = yield* FileSystem.FileSystem
    const timings = yield* Timings
    const lock = Paths.restoreLock(environment.data)
    yield* Effect.orDie(
      fs.makeDirectory(dirname(lock), { recursive: true, mode: 0o700 }),
    )
    return yield* Effect.gen(function* () {
      const release = Lock.take(lock, timings.lockBusy)
      if (release === undefined) {
        return yield* new Failure({
          code: ExitCode.failed,
          message: Messages.restoreBusy(command, environment.data),
        })
      }
      return yield* Effect.gen(function* () {
        if (
          yield* fs
            .exists(Paths.restoreCut(environment.data))
            .pipe(Effect.orDie)
        ) {
          return yield* new Failure({
            code: ExitCode.failed,
            message: Messages.restoreUnfinished(command, environment.data),
          })
        }
        return yield* write
      }).pipe(Effect.ensuring(Effect.sync(release)))
    }).pipe(Effect.uninterruptible)
  })
