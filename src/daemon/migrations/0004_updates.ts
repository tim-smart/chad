import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The lines that wait to tell a session's model what chad posted in its thread, and the notice keys. This file is
// never edited once it has shipped.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE session_updates (
      session_id TEXT,
      seq INTEGER,
      turn_id TEXT,
      outcome TEXT,
      failure TEXT,
      notice_key TEXT,
      text TEXT,
      PRIMARY KEY (session_id, seq)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE notices (
      key TEXT PRIMARY KEY,
      last_sent_at INTEGER,
      holds INTEGER,
      recorded_at INTEGER,
      text TEXT,
      delivered INTEGER
    ) STRICT
  `
})
