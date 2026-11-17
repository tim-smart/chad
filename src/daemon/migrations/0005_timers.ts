import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The timers schema: one row per plugin timer, which decides whether a run is still wanted. `cron` is null for a
// one-shot, and `next_run` is the one stored run in milliseconds since the epoch. This file is never edited once it
// has shipped.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE timers (
      plugin TEXT NOT NULL,
      name TEXT NOT NULL,
      cron TEXT,
      timezone TEXT,
      thread TEXT NOT NULL,
      prompt TEXT NOT NULL,
      label TEXT NOT NULL,
      mention TEXT,
      next_run INTEGER NOT NULL,
      PRIMARY KEY (plugin, name)
    ) STRICT
  `
})
