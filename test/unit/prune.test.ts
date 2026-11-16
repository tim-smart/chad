import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { expect, it, onTestFinished } from "vitest"
import * as Prune from "../../src/daemon/Prune.ts"
import * as Storage from "../../src/daemon/Storage.ts"
import * as Volume from "../../src/daemon/Volume.ts"

const day = 24 * 3600 * 1000

it("the prune takes only sessions reset more than 30 days ago: their directories and their history and updates go, their rows stay with the prompt cleared and no turns row is touched, and a session whose prune a kill cut after its directory went is finished by the next run", async () => {
  const data = mkdtempSync(join(tmpdir(), "chad-prune-"))
  onTestFinished(() => rmSync(data, { recursive: true, force: true }))
  mkdirSync(join(data, "db"))
  const volume = Volume.make(data)
  const layer = Layer.merge(NodeServices.layer, Storage.layer(volume))
  await Effect.runPromise(Storage.migrate.pipe(Effect.provide(layer)))

  const now = Date.now()
  // "cut" is a session whose prune a kill ended after its directory was deleted and before its rows were.
  const sessions = {
    old: now - 31 * day,
    cut: now - 40 * day,
    recent: now - 29 * day,
    open: undefined,
  } as const
  const db = new DatabaseSync(volume.database)
  for (const [id, ended] of Object.entries(sessions)) {
    db.prepare(
      "INSERT INTO sessions (id, thread, created_at, ended_at, environment, system, chunks) VALUES (?, 'local:dm', ?, ?, 'env', 'prompt', '[]')",
    ).run(id, now - 60 * day, ended ?? null)
    db.prepare(
      "INSERT INTO session_messages (session_id, message) VALUES (?, 'hello')",
    ).run(id)
    db.prepare(
      "INSERT INTO session_updates (session_id, seq, text) VALUES (?, 1, 'update')",
    ).run(id)
    db.prepare(
      "INSERT INTO turns (request_key, session_id, ended_at) VALUES (?, ?, ?)",
    ).run(`turn-${id}`, id, now - 50 * day)
    if (id !== "cut") mkdirSync(join(volume.sessions, id), { recursive: true })
  }
  db.close()

  const pruned = await Effect.runPromise(
    Prune.run({ sessions: volume.sessions, before: now - 30 * day }).pipe(
      Effect.provide(layer),
    ),
  )
  expect(pruned).toBe(2)

  const read = new DatabaseSync(volume.database, { readOnly: true })
  onTestFinished(() => read.close())
  const count = (table: string, id: string) =>
    Number(
      (
        read
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`)
          .get(id) as { n: number }
      ).n,
    )
  const row = (id: string) =>
    read
      .prepare("SELECT environment, system, chunks FROM sessions WHERE id = ?")
      .get(id)
  for (const id of ["old", "cut"]) {
    expect(existsSync(join(volume.sessions, id))).toBe(false)
    expect(count("session_messages", id)).toBe(0)
    expect(count("session_updates", id)).toBe(0)
    expect(count("turns", id)).toBe(1)
    expect({ ...row(id) }).toEqual({
      environment: null,
      system: null,
      chunks: null,
    })
  }
  for (const id of ["recent", "open"]) {
    expect(existsSync(join(volume.sessions, id))).toBe(true)
    expect(count("session_messages", id)).toBe(1)
    expect(count("session_updates", id)).toBe(1)
    expect(count("turns", id)).toBe(1)
    expect({ ...row(id) }).toEqual({
      environment: "env",
      system: "prompt",
      chunks: "[]",
    })
  }
})
