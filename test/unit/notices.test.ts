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
import { ChatError } from "effect/chat"
import { expect, it, onTestFinished } from "vitest"
import type { Chats } from "../../src/daemon/Chats.ts"
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

it("a notice row that cannot be written is held in memory and written by the next write that succeeds", async () => {
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

it("a restarted daemon posts where state/notice-thread says, and keeps a direct message as the destination while the owner writes in a server thread", async () => {
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
  // The model of the session in that thread is told at its next turn.
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

it("a restored destination whose kind the platform cannot say stays while the owner writes in a server thread, and its notice is posted as a server's, until the platform says it is a server thread", async () => {
  const data = volume()
  const posted: Array<string> = []
  const first = await boot(data, posted)
  const saved = { connection: "local", thread: "local:saved", direct: false }
  await Effect.runPromise(first.notices.arrived(saved))
  await first.stop()

  let kind: boolean | undefined = undefined
  const second = await boot(data, posted, undefined, () => kind)
  const server = { connection: "local", thread: "local:server", direct: false }
  const file = () =>
    JSON.parse(readFileSync(join(data, "state/notice-thread"), "utf8"))
  await Effect.runPromise(second.notices.arrived(server))
  expect(file()).toEqual({ connection: "local", thread: "local:saved" })
  await Effect.runPromise(second.notices.raise(low))
  await until(() => posted.length === 1)
  expect(second.posts).toEqual([{ thread: "local:saved", direct: false }])

  kind = false
  await Effect.runPromise(second.notices.arrived(server))
  expect(file()).toEqual({ connection: "local", thread: "local:server" })
})

it("a restored command-only DM whose lookup fails with Unauthenticated or Unsupported stays the destination when the owner writes in another connection's server thread", async () => {
  for (const reason of [
    new ChatError.Unauthenticated({}),
    new ChatError.Unsupported({ capability: "getThread" }),
  ]) {
    const data = volume()
    const posted: Array<string> = []
    const first = await boot(data, posted)
    // A command reached the DM, so no session row says it is one.
    const dm = { connection: "home", thread: "discord:dm", direct: true }
    await Effect.runPromise(first.notices.arrived(dm))
    await first.stop()

    const connections = ["home", "work"].map((name) => ({
      name,
      kind: "discord" as const,
      owners: ["1"],
    }))
    // Only the lookup is reached: it waits for no adapter and the platform refuses it.
    const chats = {
      ready: () => Effect.void,
      get: () =>
        Effect.succeed({
          getThread: () =>
            Effect.fail(
              new ChatError.ChatError({
                platform: "discord",
                op: "getThread",
                reason,
              }),
            ),
        }),
    } as unknown as Chats["Service"]
    const second = await boot(
      data,
      posted,
      undefined,
      undefined,
      Notices.directMessage(chats, () => connections),
    )
    const server = {
      connection: "work",
      thread: "discord:server",
      direct: false,
    }
    await Effect.runPromise(second.notices.arrived(server))
    expect(
      JSON.parse(readFileSync(join(data, "state/notice-thread"), "utf8")),
    ).toEqual({ connection: "home", thread: "discord:dm" })
    await Effect.runPromise(second.notices.raise(low))
    await until(() => posted.length === 1)
    expect(second.posts).toEqual([{ thread: "discord:dm", direct: false }])
    await second.stop()
  }
})
