import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// What stays true of a request across a restart and a compaction. `prompts` holds a row for each turn whose prompt
// the stored history took, and `commands` a row for each chat command chad ran. This file is never edited once it has
// shipped.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE prompts (
      request_key TEXT PRIMARY KEY,
      session_id TEXT
    ) STRICT
  `
  yield* sql`
    CREATE TABLE commands (
      event_key TEXT PRIMARY KEY,
      thread TEXT,
      ran_at INTEGER
    ) STRICT
  `
})
