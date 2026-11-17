import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
 * One daemon's notices on a volume. Its post records the text it was given, and fails while `failing` says so. Its
 * platform says what `kind` says of every thread, which is no direct message unless the test says otherwise, and
 * `undefined` when it cannot say. Stopping it closes its scope and its database, as a stop or a kill
 * does.
 */
const boot = async (
  data: string,
  posted: Array<string>,
  failing: () => boolean = () => false,
  kind: () => boolean | undefined = () => false,
  lookup: (
    destination: Notices.Destination,
  ) => Effect.Effect<boolean | undefined> = () => Effect.sync(kind),
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
  const posts: Array<{ thread: string; direct: boolean }> = []
  const notices = await Effect.runPromise(
    Notices.make({
      data,
      quiet: Duration.hours(24),
      post: (destination, direct, text) =>
        Effect.suspend(() => {
          attempts.push(text)
          posts.push({ thread: destination.thread, direct })
          if (failing()) return Effect.fail("the platform is down")
          posted.push(text)
          return Effect.void
        }),
      direct: lookup,
    }).pipe(Effect.provideContext(context), Scope.provide(scope)),
  )
  return {
    notices,
    attempts,
    posts,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

const low = Notices.diskLow(500 * 1024 * 1024)

it("a condition's notice is sent once while it holds, a restart and a day included, and a condition that begins again is announced only 24 hours after its last notice", async () => {
  const data = volume()
  const posted: Array<string> = []
  const first = await boot(data, posted)
  await Effect.runPromise(first.notices.arrived(direct))
  await Effect.runPromise(first.notices.raise(low))
  await until(() => row(data, "disk-low")?.["delivered"] === 1)
  await Effect.runPromise(first.notices.raise(low))
  await first.stop()
  expect(posted).toEqual([low.text])

  // More than a day after the notice, a restarted daemon finds the condition still held and does not announce it.
  const day = 25 * 3600 * 1000
  const earlier = (key: string) =>
    database(data, (db) =>
      db.exec(
        `UPDATE notices SET last_sent_at = last_sent_at - ${day} WHERE key = '${key}'`,
      ),
    )
  earlier("disk-low")
  const held = row(data, "disk-low")
  const second = await boot(data, posted)
  await Effect.runPromise(second.notices.raise(low))
  expect(row(data, "disk-low")).toEqual(held)

  // Once it clears, it is announced when it begins again.
  await Effect.runPromise(second.notices.clear("disk-low"))
  expect(row(data, "disk-low")).toMatchObject({
    holds: 0,
    last_sent_at: held?.["last_sent_at"],
  })
  await Effect.runPromise(second.notices.raise(low))
  await until(
    () =>
      row(data, "disk-low")?.["delivered"] === 1 &&
      row(data, "disk-low")?.["last_sent_at"] !== held?.["last_sent_at"],
  )
  const sent = row(data, "disk-low")?.["last_sent_at"]

  // Within 24 hours of that notice, a condition that clears and begins again is not announced.
  await Effect.runPromise(second.notices.clear("disk-low"))
  await Effect.runPromise(second.notices.raise(low))
  expect(row(data, "disk-low")).toMatchObject({ holds: 1, last_sent_at: sent })
  expect(posted).toEqual([low.text, low.text])
  expect(second.attempts).toEqual([low.text])
})

it("a notice with no session to go to is posted once when the first session exists, and one whose post fails twice is recorded as not delivered", async () => {
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
