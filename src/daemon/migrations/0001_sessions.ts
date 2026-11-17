import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The first schema. Later columns and tables come in a migration of their own, and this file is never edited once
// it has shipped.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      thread TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT
  `
  yield* sql`CREATE INDEX sessions_thread ON sessions (thread, created_at)`
})
