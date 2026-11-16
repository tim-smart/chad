import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Cause, Data, Effect } from "effect"
import { SqlClient } from "effect/sql"
import sessions from "./migrations/0001_sessions.ts"
import turns from "./migrations/0002_turns.ts"
import kills from "./migrations/0003_kills.ts"
import updates from "./migrations/0004_updates.ts"
import type { Volume } from "./Volume.ts"

/** The number of cluster shards chad runs with, from the first release. */
export const shards = 1

/** chad's migrations, compiled in. They only go forward, and a delivered one is never edited. */
export const migrations = {
  "0001_sessions": sessions,
  "0002_turns": turns,
  "0003_kills": kills,
  "0004_updates": updates,
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
/**
 * Drops one plugin's key-value table, `plugin_kv_<name>` quoted as `layerSql` quotes it, in one transaction, and gives
 * the number of keys it held, or nothing when the plugin has no table. No other table is touched (STO-61, STO-162).
 */
export const dropPluginTable = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = `plugin_kv_${name}`
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const found =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`
        if (found.length === 0) return undefined
        const [row] = yield* sql<{
          readonly count: number | bigint
        }>`SELECT COUNT(*) AS count FROM ${sql(table)}`
        yield* sql`DROP TABLE ${sql(table)}`
        return Number(row?.count ?? 0)
      }),
    )
  })

export const migrate = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord(migrations),
})

export class UnknownMigration extends Data.TaggedError("UnknownMigration")<{
  readonly message: string
}> {}

/**
 * Refuses a database that holds a migration this chad does not know, as a restored file from a newer image does
 * (STO-41). It is chad's own check, because the migrator only runs the migrations above the newest one it finds and
 * says nothing about one it does not have.
 */
export const known = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const table =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`
  if (table.length === 0) return
  const rows = yield* sql<{
    migration_id: number | bigint
    name: string
  }>`SELECT migration_id, name FROM effect_sql_migrations`
  const ours = new Set(
    Object.keys(migrations).map((key) => {
      const [id, ...name] = key.split("_")
      return `${Number(id)}_${name.join("_")}`
    }),
  )
  const unknown = rows
    .filter((row) => !ours.has(`${Number(row.migration_id)}_${row.name}`))
    .map((row) => `${String(row.migration_id).padStart(4, "0")}_${row.name}`)
  if (unknown.length > 0) {
    return yield* new UnknownMigration({
      message: `it holds the migration ${unknown.join(", ")}, which this chad does not know`,
    })
  }
})

/** The text of what made the database unusable: each distinct message down the error's chain of causes. */
export const describe = (cause: Cause.Cause<unknown>): string => {
  const messages: Array<string> = []
  let at: unknown = Cause.squash(cause)
  for (
    let depth = 0;
    depth < 8 && typeof at === "object" && at !== null;
    depth++
  ) {
    const message = (at as { readonly message?: unknown }).message
    if (
      typeof message === "string" &&
      message !== "" &&
      !messages.includes(message)
    ) {
      messages.push(message)
    }
    at = (at as { readonly cause?: unknown }).cause
  }
  return messages.length === 0
    ? String(Cause.squash(cause))
    : messages.join(": ")
}
