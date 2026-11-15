import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Makes `prompts` hold only what a volume can show (STO-210). The migration before this one also filled it for an
// unfinished turn from a history that carried no request key, which does not show that the turn's prompt was stored,
// and that part of it is stopped (STO-209). This file is never edited once its slice is delivered.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // A turn whose usage was recorded stored its prompt: clanka puts a send's prompt batch on its output before any of
  // its usage, and chad stores each part before it reads the next.
  yield* sql`
    INSERT OR IGNORE INTO prompts (request_key, session_id)
    SELECT request_key, session_id FROM turns
    WHERE ended_at IS NULL AND input_tokens + output_tokens > 0
  `
  // A row for an unfinished turn that was already there when the migration before this one ran, with no stored
  // message that carries its key and no recorded usage, may be that migration's inference, so it goes. Such a turn
  // resumes as one whose prompt was not stored (SES-161).
  yield* sql`
    DELETE FROM prompts WHERE request_key IN (
      SELECT t.request_key FROM turns t
      WHERE t.ended_at IS NULL
        AND t.input_tokens + t.output_tokens = 0
        AND t.started_at < 1000 * (1 + (
          SELECT unixepoch(created_at) FROM effect_sql_migrations WHERE migration_id = 4
        ))
        AND NOT EXISTS (
          SELECT 1 FROM session_messages m
          WHERE json_extract(m.message, '$.options.chad.request') = t.request_key
        )
    )
  `
})
