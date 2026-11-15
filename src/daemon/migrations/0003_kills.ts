import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The `kills` slice's schema: what stays true of a request across a restart and a compaction. `prompts` holds a row
// for each turn whose prompt the stored history took (STO-207), and `commands` a row for each chat command chad ran
// (STO-208). This file is never edited once its slice is delivered.
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
