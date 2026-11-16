import { join } from "node:path"
import { Cause, Cron, Duration, Effect, FileSystem } from "effect"
import { ClusterCron } from "effect/cluster"
import { SqlClient } from "effect/sql"
import * as Messages from "../Messages.ts"
import * as Logger from "./Logger.ts"
import type * as Notices from "./Notices.ts"

/**
 * The nightly prune, the only job that deletes old session data (docs/spec/02-storage.md, "Pruning and retention").
 */

/** The key of "the nightly prune failed", a table key that the next prune that succeeds clears (FAIL-312). */
export const failedKey = "prune-failed"

/**
 * Prunes each session that was reset before `before`, in milliseconds since the epoch: its directory under `sessions`
 * first, then its history and its updates in a transaction of its own that also clears the prompt and the environment
 * of its row. The row stays and no `turns` row is touched. A session whose row is not cleared yet is selected again,
 * so the next run finishes one that an exit cut (STO-105, STO-106, STO-107, STO-171, STO-183, STO-185). It gives the
 * number of sessions it pruned.
 */
export const run = Effect.fnUntraced(function* (options: {
  readonly sessions: string
  readonly before: number
}) {
  const sql = yield* SqlClient.SqlClient
  const fs = yield* FileSystem.FileSystem
  const due = yield* sql<{ readonly id: string }>`
    SELECT id FROM sessions s
    WHERE ended_at IS NOT NULL AND ended_at < ${options.before} AND (
      environment IS NOT NULL OR system IS NOT NULL OR chunks IS NOT NULL
      OR EXISTS (SELECT 1 FROM session_messages m WHERE m.session_id = s.id)
      OR EXISTS (SELECT 1 FROM session_updates u WHERE u.session_id = s.id)
    )
    ORDER BY ended_at
  `
  for (const { id } of due) {
    yield* fs.remove(join(options.sessions, id), {
      recursive: true,
      force: true,
    })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM session_messages WHERE session_id = ${id}`
        yield* sql`DELETE FROM session_updates WHERE session_id = ${id}`
        yield* sql`UPDATE sessions SET environment = NULL, system = NULL, chunks = NULL WHERE id = ${id}`
      }),
    )
  }
  return due.length
})

/**
 * The prune as a `ClusterCron` in its default mode, at `at` in the owner's timezone as the boot read it, so a change of
 * timezone reaches it at the next restart (STO-104, STO-109, STO-111). A run that fails is logged and raises
 * `prune-failed`, and one that succeeds clears it (FAIL-284, FAIL-312).
 */
export const layer = (options: {
  readonly sessions: string
  readonly zone: string
  readonly at: string
  readonly age: Duration.Duration
  readonly notices: Notices.Notices["Service"]
}) =>
  ClusterCron.make({
    name: "prune",
    cron: Cron.parseUnsafe(options.at, options.zone),
    execute: Effect.suspend(() =>
      run({
        sessions: options.sessions,
        before: Date.now() - Duration.toMillis(options.age),
      }),
    ).pipe(
      Effect.andThen(options.notices.clear(failedKey)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Logger.event("prune.failed", "The nightly prune failed", {
              error: Messages.firstLine(Cause.pretty(cause)),
            }).pipe(
              Effect.andThen(
                options.notices.raise({
                  key: failedKey,
                  text: Messages.pruneFailed(Cause.pretty(cause)),
                }),
              ),
            ),
      ),
    ),
  })
