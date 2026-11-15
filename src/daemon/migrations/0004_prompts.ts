import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Fills `prompts` for a volume whose history was written before the table existed (STO-209), so a turn that a kill
// cut there is not taken for one whose prompt was never stored. It runs once, before any turn resumes. This file is
// never edited once its slice is delivered.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // A stored prompt that carries its request key.
  yield* sql`
    INSERT OR IGNORE INTO prompts (request_key, session_id)
    SELECT json_extract(message, '$.options.chad.request'), session_id
    FROM session_messages
    WHERE json_extract(message, '$.options.chad.request') IS NOT NULL
  `
  // An unfinished turn whose session has a stored history in which no prompt carries a key was written before prompts
  // carried one, and its prompt was stored with the rest.
  yield* sql`
    INSERT OR IGNORE INTO prompts (request_key, session_id)
    SELECT t.request_key, t.session_id
    FROM turns t
    WHERE t.ended_at IS NULL
      AND t.starts > 0
      AND EXISTS (SELECT 1 FROM session_messages m WHERE m.session_id = t.session_id)
      AND NOT EXISTS (
        SELECT 1 FROM session_messages m
        WHERE m.session_id = t.session_id
          AND json_extract(m.message, '$.options.chad.request') IS NOT NULL
      )
  `
})
