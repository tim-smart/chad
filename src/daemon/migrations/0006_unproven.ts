import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Records the unfinished turns whose prompt the volume can show neither as stored nor as never stored (STO-211). They
// are the turns the migration before this one took the `prompts` row from, or would have: that removal cannot tell a
// row STO-207 wrote with the prompt from one that STO-209's stopped half inferred, and it ran before this file could
// look. This file is never edited once its slice is delivered.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE unproven (
      request_key TEXT PRIMARY KEY,
      session_id TEXT
    ) STRICT
  `
  yield* sql`
    INSERT INTO unproven (request_key, session_id)
    SELECT t.request_key, t.session_id FROM turns t
    WHERE t.ended_at IS NULL
      AND t.input_tokens + t.output_tokens = 0
      AND t.started_at < 1000 * (1 + (
        SELECT unixepoch(created_at) FROM effect_sql_migrations WHERE migration_id = 4
      ))
      AND NOT EXISTS (
        SELECT 1 FROM session_messages m
        WHERE json_extract(m.message, '$.options.chad.request') = t.request_key
      )
  `
})
