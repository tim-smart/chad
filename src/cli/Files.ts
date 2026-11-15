import { dirname } from "node:path"
import { Duration, Effect, FileSystem, Result, SemVer } from "effect"
import * as Errno from "../Errno.ts"
import * as Lock from "../Lock.ts"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
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
      const release = Lock.take(environment.lock, Duration.zero)
      if (release === undefined) {
        return yield* new Failure({
          code: ExitCode.failed,
          message: Messages.daemonStarted(command),
        })
      }
      return yield* Effect.ensuring(write, Effect.sync(release))
    }).pipe(Effect.uninterruptible)
  })
