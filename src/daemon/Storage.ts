import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Data, Effect } from "effect"
import { SqlClient } from "effect/sql"
import sessions from "./migrations/0001_sessions.ts"
import turns from "./migrations/0002_turns.ts"
import type { Volume } from "./Volume.ts"

/** The number of cluster shards chad runs with, from the first release. */
export const shards = 1

/** chad's migrations, compiled in. They only go forward, and a delivered one is never edited. */
export const migrations = {
  "0001_sessions": sessions,
  "0002_turns": turns,
}

/** The one connection to `db/chad.db`, serialized, in WAL mode and with the driver's 5 second busy timeout. */
export const layer = (volume: Volume) =>
  SqliteClient.layer({ filename: volume.database })

export class ShardCountChanged extends Data.TaggedError("ShardCountChanged")<{
  readonly stored: number
  readonly now: number
}> {}

/**
 * The shard count guard. It keeps the count the database was made with in a row of `chad_meta`, which it creates
 * itself because it runs before the migrations, and fails when the row holds another count.
 */
export const guard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS chad_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`
  const rows = yield* sql<{
    value: string
  }>`SELECT value FROM chad_meta WHERE key = 'shards'`
  const stored = rows[0]?.value
  if (stored === undefined) {
    yield* sql`INSERT INTO chad_meta (key, value) VALUES ('shards', ${String(shards)})`
  } else if (Number(stored) !== shards) {
    return yield* new ShardCountChanged({ stored: Number(stored), now: shards })
  }
})

/** Runs the migrations that the database does not hold yet, under `Migrator`'s default table name. */
export const migrate = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord(migrations),
})
