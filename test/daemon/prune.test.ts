// The nightly prune as the daemon runs it: on its ClusterCron schedule, given one of every second.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { execute, query } from "../support/database.ts"
import { scenario } from "../support/driver.ts"
import { eventually } from "../support/owner.ts"

const day = 24 * 3600 * 1000

test("the daemon's scheduled prune deletes a reset session's history in one transaction, so a run that fails part way deletes none of it, raises prune-failed, and the next run finishes it and clears the notice", async () => {
  const running = await scenario({ timings: { pruneAt: "* * * * * *" } })
  const { data } = running
  await running.logged("boot.ready")
  // The deletion of the updates fails, after the history's deletion in the same transaction ran.
  execute(
    data,
    "CREATE TRIGGER held BEFORE DELETE ON session_updates BEGIN SELECT RAISE(ABORT, 'held'); END",
  )
  const now = Date.now()
  execute(
    data,
    `INSERT INTO sessions (id, thread, created_at, ended_at, environment, system, chunks) VALUES ('old', 'local:dm', ${now - 60 * day}, ${now - 31 * day}, 'env', 'prompt', '[]');
     INSERT INTO session_messages (session_id, message) VALUES ('old', 'hello');
     INSERT INTO session_updates (session_id, seq, text) VALUES ('old', 1, 'update');
     INSERT INTO turns (request_key, session_id, ended_at) VALUES ('turn-old', 'old', ${now - 50 * day});`,
  )
  mkdirSync(join(data, "sessions/old"), { recursive: true })
  writeFileSync(join(data, "sessions/old/file"), "work")

  await running.logged("prune.failed")
  const left = () => ({
    messages: query(
      data,
      "SELECT count(*) AS n FROM session_messages WHERE session_id = 'old'",
    )[0]?.["n"],
    updates: query(
      data,
      "SELECT count(*) AS n FROM session_updates WHERE session_id = 'old'",
    )[0]?.["n"],
    row: query(
      data,
      "SELECT environment, system, chunks FROM sessions WHERE id = 'old'",
    )[0],
    notice: query(
      data,
      "SELECT holds FROM notices WHERE key = 'prune-failed'",
    )[0]?.["holds"],
  })
  expect(existsSync(join(data, "sessions/old"))).toBe(false)
  expect(left()).toEqual({
    messages: 1n,
    updates: 1n,
    row: { environment: "env", system: "prompt", chunks: "[]" },
    notice: 1n,
  })

  execute(data, "DROP TRIGGER held")
  const after = await eventually(
    left,
    (now) => now.messages === 0n && now.notice !== 1n,
  )
  expect(after).toMatchObject({
    updates: 0n,
    row: { environment: null, system: null, chunks: null },
  })
  expect(
    query(data, "SELECT request_key FROM turns WHERE session_id = 'old'"),
  ).toEqual([{ request_key: "turn-old" }])
}, 30_000)
