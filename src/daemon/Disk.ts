import { statfs } from "node:fs/promises"
import { Cause, Duration, Effect, Schedule } from "effect"
import * as Logger from "./Logger.ts"
import * as Notices from "./Notices.ts"

/** Below 1 GB free the condition `disk-low` holds, and at 1 GB or more it clears. */
export const threshold = 1024 ** 3

/**
 * The bytes the daemon's user can use on the volume, `bavail * bsize` from `statfs`, which Effect's `FileSystem`
 * does not have.
 */
export const freeSpace = (path: string): Effect.Effect<number, unknown> =>
  Effect.tryPromise(() => statfs(path)).pipe(
    Effect.map((stats) => stats.bavail * stats.bsize),
  )

/** What the check does with what it finds: the notice of `disk-low` and its clearing. */
export type Condition = Pick<Notices.Notices["Service"], "raise" | "clear">

/** One run of the free space check. A read that fails changes nothing and is logged. */
export const check = (
  free: Effect.Effect<number, unknown>,
  condition: Condition,
) =>
  Effect.gen(function* () {
    const bytes = yield* free
    if (bytes >= threshold) return yield* condition.clear("disk-low")
    yield* Logger.event(
      "disk.low",
      "The free space check found less than 1 GB",
      {
        free_bytes: bytes,
      },
    )
    yield* condition.raise(Notices.diskLow(bytes))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "The free space check could not read free space",
        cause,
      ),
    ),
  )

/**
 * The free space check at boot and then at every interval, a plain timer kept off `ClusterCron`. It
 * runs until the scope it is forked in closes.
 */
export const start = (
  data: string,
  interval: Duration.Duration,
  condition: Condition,
) =>
  check(freeSpace(data), condition).pipe(
    Effect.repeat(Schedule.spaced(interval)),
    Effect.forkScoped,
  )

/** SQLite's primary result code for a full database or disk, `SQLITE_FULL`, and the text SQLite gives it. */
const sqliteFull = 13
const sqliteFullText = "database or disk is full"

const fullIn = (value: unknown, depth: number): boolean => {
  if (typeof value !== "object" || value === null || depth > 8) return false
  const found = value as {
    readonly errcode?: unknown
    readonly code?: unknown
    readonly message?: unknown
    readonly cause?: unknown
    readonly reason?: unknown
  }
  if (
    typeof found.errcode === "number" &&
    (found.errcode & 0xff) === sqliteFull
  )
    return true
  if (found.message === sqliteFullText || found.code === "ENOSPC") return true
  return (
    fullIn(found.cause, depth + 1) ||
    (found.reason !== found.cause && fullIn(found.reason, depth + 1))
  )
}

/**
 * Whether a write of chad's failed because the volume is full: SQLite's full error, which `node:sqlite` gives by its
 * code and its text, or a file write's `ENOSPC`. It looks through cluster's and `effect/sql`'s wrappers.
 */
export const isFull = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) =>
    fullIn(
      reason._tag === "Fail"
        ? reason.error
        : reason._tag === "Die"
          ? reason.defect
          : undefined,
      0,
    ),
  )
