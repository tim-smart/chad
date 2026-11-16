import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The turns schema: the rest of a session's row, its history, the record of every turn and the record of every
// message that steered one. This file is never edited once it has shipped.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const column of [
    "kind TEXT",
    "ended_at INTEGER",
    "environment TEXT",
    "system TEXT",
    "chunks TEXT",
    "generation INTEGER NOT NULL DEFAULT 0",
    "fingerprint TEXT",
    "last_message_id TEXT",
    "last_message_at INTEGER",
    "tasks TEXT NOT NULL DEFAULT '[]'",
  ]) {
    yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN ${column}`)
  }
  yield* sql`
    CREATE TABLE session_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message TEXT NOT NULL
    ) STRICT
  `
  yield* sql`CREATE INDEX session_messages_session ON session_messages (session_id, seq)`
  yield* sql`
    CREATE TABLE turns (
      request_key TEXT PRIMARY KEY,
      turn_id TEXT,
      session_id TEXT,
      origin TEXT,
      origin_plugin TEXT,
      origin_label TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      outcome TEXT,
      failure TEXT,
      failure_detail TEXT,
      status_message_id TEXT,
      starts INTEGER NOT NULL DEFAULT 0,
      graceful_cuts INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0
    ) STRICT
  `
  yield* sql`CREATE INDEX turns_started_at ON turns (started_at)`
  yield* sql`CREATE INDEX turns_session_started_at ON turns (session_id, started_at)`
  yield* sql`
    CREATE TABLE steers (
      request_key TEXT PRIMARY KEY,
      turn_id TEXT
    ) STRICT
  `
})
