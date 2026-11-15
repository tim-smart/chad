import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import { expect, it, onTestFinished } from "vitest"
import * as Notices from "../../src/daemon/Notices.ts"
import * as Storage from "../../src/daemon/Storage.ts"
import * as Volume from "../../src/daemon/Volume.ts"

const volume = () => {
  const data = mkdtempSync(join(tmpdir(), "chad-unit-"))
  mkdirSync(join(data, "db"))
  onTestFinished(() => rmSync(data, { recursive: true, force: true }))
  return data
}

const database = <A>(data: string, use: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(join(data, "db/chad.db"))
  try {
    return use(db)
  } finally {
    db.close()
  }
}

/** A key's `notices` row, read from outside the daemon. */
const row = (data: string, key: string) =>
  database(data, (db) =>
    db.prepare("SELECT * FROM notices WHERE key = ?").get(key),
  )

const until = async (done: () => boolean) => {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 5))
}

const direct = { connection: "local", thread: "local:dm", direct: true }

/**
 * One daemon's notices on a volume. Its post records the text it was given, and fails while `failing` says so.
 * Stopping it closes its scope and its database, as a stop or a kill does.
 */
const boot = async (
  data: string,
  posted: Array<string>,
  failing: () => boolean = () => false,
) => {
  const scope = Effect.runSync(Scope.make())
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.merge(NodeServices.layer, Storage.layer(Volume.make(data))),
      scope,
    ),
  )
  await Effect.runPromise(Storage.migrate.pipe(Effect.provideContext(context)))
  const attempts: Array<string> = []
  const notices = await Effect.runPromise(
    Notices.make({
      data,
      quiet: Duration.hours(24),
      post: (_, __, text) =>
        Effect.suspend(() => {
          attempts.push(text)
          if (failing()) return Effect.fail("the platform is down")
          posted.push(text)
          return Effect.void
        }),
    }).pipe(Effect.provideContext(context), Scope.provide(scope)),
  )
  return {
    notices,
    attempts,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

const low = Notices.diskLow(500 * 1024 * 1024)

it("FAIL-150 FAIL-151 FAIL-152 STO-129 STO-130 a condition's notice is sent once while it holds, a restart included, and a condition that begins again within 24 hours of its last notice is not announced", async () => {
  const data = volume()
  const posted: Array<string> = []
  const first = await boot(data, posted)
  await Effect.runPromise(first.notices.arrived(direct))
  await Effect.runPromise(first.notices.raise(low))
  await until(() => row(data, "disk-low")?.["delivered"] === 1)
  await Effect.runPromise(first.notices.raise(low))
  await first.stop()
  expect(posted).toEqual([low.text])
  const sent = row(data, "disk-low")?.["last_sent_at"]

  const second = await boot(data, posted)
  await Effect.runPromise(second.notices.raise(low))
  await Effect.runPromise(second.notices.clear("disk-low"))
  expect(row(data, "disk-low")).toMatchObject({ holds: 0, last_sent_at: sent })
  await Effect.runPromise(second.notices.raise(low))
  expect(row(data, "disk-low")).toMatchObject({ holds: 1, last_sent_at: sent })
  expect(posted).toEqual([low.text])

  // A day after the last notice, the condition is announced when it begins again.
  database(data, (db) =>
    db.exec(
      `UPDATE notices SET last_sent_at = last_sent_at - ${25 * 3600 * 1000}`,
    ),
  )
  await Effect.runPromise(second.notices.clear("disk-low"))
  await Effect.runPromise(second.notices.raise(low))
  await until(() => posted.length === 2)
  expect(second.attempts).toEqual([low.text])
})

it("FAIL-160 REC-110 a notice with no session to go to is posted once when the first session exists, and one whose post fails twice is recorded as not delivered", async () => {
  const data = volume()
  const posted: Array<string> = []
  const first = await boot(data, posted)
  await Effect.runPromise(first.notices.raise(low))
  expect(row(data, "disk-low")).toMatchObject({ holds: 1, delivered: 0 })
  await Effect.runPromise(first.notices.arrived(direct))
  await until(() => row(data, "disk-low")?.["delivered"] === 1)
  expect(posted).toEqual([low.text])
  await first.stop()

  const other = volume()
  let failing = true
  // The destination is the one `state/notice-thread` recorded before the boot.
  mkdirSync(join(other, "state"))
  writeFileSync(
    join(other, "state/notice-thread"),
    JSON.stringify({ connection: direct.connection, thread: direct.thread }) +
      "\n",
  )
  const down = await boot(other, posted, () => failing)
  await Effect.runPromise(down.notices.raise(low))
  await until(() => down.attempts.length === 2)
  failing = false
  await down.stop()
  expect(down.attempts).toHaveLength(2)
  expect(row(other, "disk-low")).toMatchObject({
    holds: 1,
    delivered: 0,
    last_sent_at: null,
  })
  expect(posted).toEqual([low.text])
})

it("FAIL-230 a notice row that cannot be written is held in memory and written by the next write that succeeds", async () => {
  const data = volume()
  const posted: Array<string> = []
  const running = await boot(data, posted)
  await Effect.runPromise(running.notices.arrived(direct))
  database(data, (db) =>
    db.exec(
      "CREATE TRIGGER full BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
    ),
  )
  await Effect.runPromise(running.notices.raise(low))
  await until(() => posted.length === 1)
  // The held row still says the condition holds, so it is not announced again.
  await Effect.runPromise(running.notices.raise(low))
  expect(row(data, "disk-low")).toBeUndefined()
  expect(running.notices.problems()).toEqual([low.text])

  database(data, (db) => db.exec("DROP TRIGGER full"))
  const lower = Notices.diskLow(400 * 1024 * 1024)
  await Effect.runPromise(running.notices.raise(lower))
  await until(() => row(data, "disk-low")?.["delivered"] === 1)
  expect(row(data, "disk-low")).toMatchObject({ holds: 1, text: lower.text })
  expect(posted).toEqual([low.text])
})

it("FAIL-159 FAIL-232 REC-101 a restarted daemon posts where state/notice-thread says, and keeps a direct message as the destination while the owner writes in a server thread", async () => {
  const data = volume()
  const posted: Array<string> = []
  const first = await boot(data, posted)
  database(data, (db) =>
    db.exec(
      "INSERT INTO sessions (id, thread, kind, created_at) VALUES ('s1', 'local:dm', 'direct', 1)",
    ),
  )
  await Effect.runPromise(first.notices.arrived(direct))
  await first.stop()

  const second = await boot(data, posted)
  const server = { connection: "local", thread: "local:server", direct: false }
  await Effect.runPromise(second.notices.arrived(server))
  expect(
    JSON.parse(readFileSync(join(data, "state/notice-thread"), "utf8")),
  ).toEqual({ connection: "local", thread: "local:dm" })
  await Effect.runPromise(second.notices.raise(low))
  await until(() => posted.length === 1)
  // The model of the session in that thread is told at its next turn (FAIL-131).
  await until(() =>
    database(
      data,
      (db) =>
        db
          .prepare("SELECT * FROM session_updates WHERE session_id = 's1'")
          .all().length === 1,
    ),
  )
})
