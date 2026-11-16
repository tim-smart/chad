import { SqliteClient } from "@effect/sql-sqlite-node"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
} from "effect"
import { ChatInteraction } from "effect/chat"
import type { HttpClient } from "effect/http"
import type { Socket } from "effect/socket"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import type { Connection } from "./Connection.ts"
import * as Connections from "./Connections.ts"
import * as Chats from "./Chats.ts"
import * as Disk from "./Disk.ts"
import * as Handler from "./Handler.ts"
import * as Logger from "./Logger.ts"
import * as Notices from "./Notices.ts"
import * as Queue from "./Queue.ts"
import type { DaemonInputs } from "./runDaemon.ts"
import * as Server from "./Server.ts"
import * as Storage from "./Storage.ts"
import * as Volume from "./Volume.ts"

/** The key of an unusable database, a live key with no row, because the `notices` table is in that database (FAIL-311). */
const key = "database-unusable"

/**
 * The rest of a boot whose database could not be opened or migrated (STO-117, FAIL-147). chad stays up without
 * sessions: it connects from `secrets/connections.json`, answers each owner message with the error, shows it under
 * "Problems", and tells the owner once at boot. It never returns.
 */
export const run = Effect.fnUntraced(function* (options: {
  readonly inputs: Pick<DaemonInputs, "chat" | "timings">
  readonly volume: Volume.Volume
  readonly state: Server.State
  readonly stored: ReadonlyArray<Connection>
  readonly world: Context.Context<
    FileSystem.FileSystem | HttpClient.HttpClient | Socket.WebSocketConstructor
  >
  readonly cause: Cause.Cause<unknown>
}) {
  const { inputs, volume, state, stored, world, cause } = options
  const scope = yield* Effect.scope
  const error = Storage.describe(cause)
  const text = Messages.databaseUnusable(error)
  yield* Logger.event(
    "database.unusable",
    "The database could not be opened or migrated",
    { error },
    cause,
  )

  // Its key and every other live key show under "Problems" and send no notice, because no row can record that one was
  // sent (FAIL-228, STO-119). "Recent" says why it is missing.
  const live = new Map<string, string>([[key, text]])
  state.problems.push(() => [...live.values()])
  state.recent = Effect.fail(error)
  yield* Disk.start(volume.data, inputs.timings.freeSpaceInterval, {
    raise: (notice) =>
      Effect.sync(() => {
        live.set(notice.key, notice.text)
      }),
    clear: (name) =>
      Effect.sync(() => {
        live.delete(name)
      }),
  })

  // A chat platform keeps its own state, such as Discord's shard state, in a database of its own in memory.
  const memory = yield* Layer.buildWithScope(
    SqliteClient.layer({ filename: ":memory:" }),
    scope,
  )
  const context = Context.merge(
    Context.merge(world, memory),
    Context.make(Volume.Volume, volume),
  )
  const status = Server.statusText(state)
  const running = yield* Chats.make((connection, handler) =>
    inputs.chat(connection).pipe(
      Layer.provide([
        Handler.unusable(handler, text, status),
        // No turn runs, so a click is answered and does nothing.
        ChatInteraction.layer(),
      ]),
    ),
  )
  yield* running.set(stored).pipe(Effect.provideContext(context))
  const queue = Queue.make()
  yield* Deferred.succeed(state.queue, queue)
  yield* Deferred.succeed(
    state.commands,
    yield* Connections.make(volume, state, running, queue).pipe(
      Effect.provideContext(context),
    ),
  )
  yield* Effect.forkIn(notify(volume.data, text, running), scope)
})

/**
 * Sends the error to the thread `state/notice-thread` records, once for as long as the database stays unusable,
 * restarts included: `state/db-unusable` marks the send, and only when it cannot be written is the notice sent again
 * at the next boot (STO-136, STO-186, FAIL-149, FAIL-225, FAIL-227).
 */
const notify = (data: string, text: string, running: Chats.Running<unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const mark = Paths.dbUnusable(data)
    if (yield* fs.exists(mark).pipe(Effect.orElseSucceed(() => false))) return
    const destination = yield* Notices.readDestination(data)
    if (destination === undefined) {
      return yield* Logger.event(
        "notice.undelivered",
        "A notice could not be posted, because no session is known",
        { key, text },
      )
    }
    const where = {
      connection: destination.connection,
      thread: destination.thread,
    }
    // A destination whose kind is unknown is posted in as a server's, as the notices do (FAIL-341).
    const direct =
      (yield* Notices.directMessage(
        running.chats,
        running.list,
      )(destination)) ?? false
    const post = Notices.post(running.chats, running.list)
    const posted = yield* Effect.exit(
      Effect.suspend(() => post(destination, direct, text)).pipe(
        Effect.sandbox,
        Effect.retry({ times: 1 }),
      ),
    )
    if (Exit.isFailure(posted)) {
      return yield* Logger.event(
        "notice.undelivered",
        "A notice could not be posted, because the post failed twice",
        { key, ...where, text },
        posted.cause,
      )
    }
    yield* Logger.event("notice.sent", "A notice was posted", {
      key,
      ...where,
      text,
    })
    const wrote = yield* Effect.exit(fs.writeFileString(mark, text + "\n"))
    if (Exit.isFailure(wrote)) {
      yield* Effect.logWarning(
        "state/db-unusable could not be written, so the next boot sends the notice again",
        wrote.cause,
      )
    }
  })
