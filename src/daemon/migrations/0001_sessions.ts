import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The first slice's schema. A later slice adds its columns and tables in a migration of its own, and this file is
// never edited once its slice is delivered.
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
