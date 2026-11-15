import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The `failures` slice's schema: the lines that wait to tell a session's model what chad posted in its thread
// (STO-131, STO-170, FAIL-131). This file is never edited once its slice is delivered.
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
})
