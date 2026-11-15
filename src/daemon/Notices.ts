import { dirname } from "node:path"
import { DiscordChat } from "@effect/chat-discord"
import {
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Schema,
  Semaphore,
} from "effect"
import { Chat, ChatMarkdown, ChatThread } from "effect/chat"
import { SqlClient } from "effect/sql"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import type { Connection } from "./Connection.ts"
import type { Chats } from "./Chats.ts"
import * as Logger from "./Logger.ts"
import * as Sessions from "./Sessions.ts"

/**
 * The notices outside a turn (docs/spec/16-failures-logs-status.md, "Notices outside a turn"). A notice about a
 * condition has a key, is sent when the condition begins, and is not sent again while it holds, restarts included,
 * nor within 24 hours of its last send. The `notices` table remembers both (STO-128, STO-129, FAIL-150 to FAIL-153).
 */

/** A notice about a condition: its key, and the text its key's renderer gave, which "Problems" prints too (FAIL-310). */
export interface Notice {
  readonly key: string
  readonly text: string
}

/**
 * The table keys, whose condition only their row remembers (FAIL-307). Every other key is live: the running daemon
 * answers it from memory or from files, and "Problems" never reads its row (STO-169).
 */
const tableKeys: ReadonlySet<string> = new Set(["usage-limit", "prune-failed"])

export const isTableKey = (key: string) => tableKeys.has(key)

/** The notice of `disk-low`, a live key (FAIL-171, STO-115). */
export const diskLow = (bytes: number): Notice => ({
  key: "disk-low",
  text: Messages.diskLow(bytes),
})

/** Where a notice outside a turn goes, as `state/notice-thread` holds it (STO-121, FAIL-232). */
export const Destination = Schema.Struct({
  connection: Schema.String,
  thread: Schema.String,
})
export type Destination = typeof Destination.Type

const decodeDestination = Schema.decodeUnknownOption(
  Schema.fromJsonString(Destination),
)

/**
 * The destination `state/notice-thread` records, or `undefined` when there is none or it cannot be read. It needs no
 * database, so a boot that cannot use one can still tell the owner (FAIL-232).
 */
export const readDestination = Effect.fnUntraced(function* (data: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(Paths.noticeThread(data))
    .pipe(Effect.option)
  return Option.getOrUndefined(
    Option.flatMap(text, (line) => decodeDestination(line.trim())),
  )
})

/** Writes `state/notice-thread` by temporary file and rename, as one JSON line (STO-121, FAIL-159, REC-109). */
const writeDestination = Effect.fnUntraced(function* (
  data: string,
  destination: Destination,
) {
  const fs = yield* FileSystem.FileSystem
  const target = Paths.noticeThread(data)
  yield* fs.makeDirectory(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  const { connection, thread } = destination
  yield* fs.writeFileString(
    temporary,
    JSON.stringify({ connection, thread }) + "\n",
  )
  yield* fs.rename(temporary, target)
})

export class Unpostable extends Data.TaggedError("Unpostable")<{
  readonly message: string
}> {}

/** Posts a notice's text in a destination, whose thread is a direct message when `direct` is true. */
export type Post = (
  destination: Destination,
  direct: boolean,
  text: string,
) => Effect.Effect<void, unknown>

/**
 * The post through the daemon's connections. A notice is a normal message. On Discord outside a direct message it
 * starts with the mention of each owner of the posting connection, and only those users are notified (FAIL-156,
 * DIS-74, FAIL-337). The local platform has no mentions. A post made as the daemon boots waits for the connection's
 * adapter, so that it is not refused for want of it.
 */
export const post =
  (
    chats: Chats["Service"],
    connections: () => ReadonlyArray<Connection>,
  ): Post =>
  (destination, direct, text) =>
    Effect.gen(function* () {
      const thread = ChatThread.fromString(destination.thread)
      const connection = connections().find(
        ({ name }) => name === destination.connection,
      )
      if (Option.isNone(thread) || connection === undefined) {
        return yield* new Unpostable({
          message: `there is no thread ${destination.thread} on a connection ${destination.connection}`,
        })
      }
      yield* chats.ready(connection.name)
      const chat = yield* chats.get(connection.name)
      const owners =
        connection.kind === "discord" && !direct ? connection.owners : []
      const markdown =
        owners.length === 0
          ? text
          : `${owners.map((id) => `<@${id}>`).join(" ")} ${text}`
      yield* ChatMarkdown.post(thread.value, markdown).pipe(
        Effect.provideService(Chat.Chat, chat),
        DiscordChat.withPostOptions({ notify: { users: owners } }),
      )
    })

/**
 * Whether a destination's thread is a direct message, as its platform says. A thread on no connection of this daemon,
 * or one its platform cannot say, is taken as a server's. It waits for the connection's adapter, as a post does.
 */
export const directMessage =
  (chats: Chats["Service"], connections: () => ReadonlyArray<Connection>) =>
  (destination: Destination): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const thread = ChatThread.fromString(destination.thread)
      const known = connections().some(
        ({ name }) => name === destination.connection,
      )
      if (Option.isNone(thread) || !known) return false
      yield* chats.ready(destination.connection)
      const chat = yield* chats.get(destination.connection)
      const info = yield* chat.getThread(thread.value)
      return info.kind === "direct"
    }).pipe(Effect.catchCause(() => Effect.succeed(false)))

/** What a `notices` row holds (STO-169, FAIL-229). Both times are milliseconds since the epoch. */
interface Row {
  readonly holds: boolean
  readonly recorded: number | null
  readonly sent: number | null
  readonly text: string
  readonly delivered: boolean
}

/** A destination, and whether its thread is a direct message, which is `undefined` until it is looked up. */
type Target = Destination & { readonly direct: boolean | undefined }

/** How long an owner's message waits for a platform to say whether the destination is a direct message. */
const platformWait = Duration.seconds(5)

export class Notices extends Context.Service<
  Notices,
  {
    /** A condition holds: its row records it, and its notice is sent unless the rules say otherwise. */
    readonly raise: (notice: Notice) => Effect.Effect<void>
    /** A condition cleared. Nothing is posted, and the row keeps the time its notice was last sent (FAIL-151). */
    readonly clear: (key: string) => Effect.Effect<void>
    /** An owner's message arrived in a thread, which may move the destination (FAIL-158, FAIL-231, REC-145). */
    readonly arrived: (
      at: Destination & { readonly direct: boolean },
    ) => Effect.Effect<void>
    /** The lines "Problems" shows for the live keys that hold, from memory alone (STO-169, FAIL-309). */
    readonly problems: () => ReadonlyArray<string>
    /** The lines "Problems" shows for the table keys whose row holds, with the time each was recorded (FAIL-320). */
    readonly held: Effect.Effect<ReadonlyArray<string>, unknown>
  }
>()("chad/Notices") {}

/**
 * The notices of one daemon. The destination starts as `state/notice-thread` has it (FAIL-338), and the sends run
 * in fibers of the scope it is made in, so that a post that waits for its connection holds up nothing else.
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly data: string
  /** The time after a key's last notice in which the key is not announced again (FAIL-152). */
  readonly quiet: Duration.Duration
  readonly post: Post
  /** Whether a thread is a direct message, as its platform says. */
  readonly direct: (destination: Destination) => Effect.Effect<boolean>
}) {
  const sql = yield* SqlClient.SqlClient
  const services = yield* Effect.context<FileSystem.FileSystem>()
  const scope = yield* Effect.scope
  const rows = yield* Semaphore.make(1)
  const moves = yield* Semaphore.make(1)
  const sending = yield* Semaphore.make(1)
  /** The rows that could not be written, held until a write next succeeds (FAIL-230). */
  const pending = new Map<string, Row>()
  /** The live keys that hold in this daemon, with their text. */
  const live = new Map<string, string>()

  const stored = yield* readDestination(options.data)
  // The file does not say whether its thread is a direct message (STO-121), so that is looked up when it first matters.
  let destination: Target | undefined =
    stored === undefined ? undefined : { ...stored, direct: undefined }
  /** Whether the destination in memory is newer than the file, because the file could not be written. */
  let unwritten = false

  /**
   * Whether a destination is a direct message. The thread the file named is looked up once: its session's kind, or
   * its platform's word when it has no session, because a direct message that only a command reached has none
   * (FAIL-231, REC-101). With `wait`, a platform that has not answered by then leaves the kind unknown for now, and
   * it is taken as a server's.
   */
  const directOf = (target: Target, wait?: Duration.Duration) =>
    target.direct !== undefined
      ? Effect.succeed(target.direct)
      : Effect.gen(function* () {
          const kind = yield* Sessions.kindOf(target.thread).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.provideService(SqlClient.SqlClient, sql),
          )
          const asking = options.direct(target)
          const direct =
            kind !== undefined
              ? Option.some(kind === "direct")
              : wait === undefined
                ? yield* Effect.asSome(asking)
                : yield* Effect.timeoutOption(asking, wait)
          if (Option.isNone(direct)) return false
          if (destination === target) {
            destination = { ...target, direct: direct.value }
          }
          return direct.value
        })

  const read = (key: string): Effect.Effect<Row | undefined> => {
    const held = pending.get(key)
    if (held !== undefined) return Effect.succeed(held)
    return sql<{
      holds: number
      recorded_at: number | null
      last_sent_at: number | null
      text: string
      delivered: number
    }>`SELECT holds, recorded_at, last_sent_at, text, delivered FROM notices WHERE key = ${key}`.pipe(
      Effect.map((found) => {
        const row = found[0]
        return row === undefined
          ? undefined
          : {
              holds: row.holds === 1,
              recorded: row.recorded_at,
              sent: row.last_sent_at,
              text: row.text,
              delivered: row.delivered === 1,
            }
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("A notice row could not be read", cause).pipe(
          Effect.as(undefined),
        ),
      ),
    )
  }

  /** Writes a key's row together with every row that is still held in memory, or holds them all (FAIL-230). */
  const write = (key: string, row: Row) => {
    pending.set(key, row)
    const all = [...pending]
    return sql
      .withTransaction(
        Effect.forEach(
          all,
          ([key, row]) => sql`
            INSERT INTO notices (key, last_sent_at, holds, recorded_at, text, delivered)
            VALUES (${key}, ${row.sent}, ${row.holds ? 1 : 0}, ${row.recorded}, ${row.text}, ${row.delivered ? 1 : 0})
            ON CONFLICT (key) DO UPDATE SET last_sent_at = excluded.last_sent_at, holds = excluded.holds,
              recorded_at = excluded.recorded_at, text = excluded.text, delivered = excluded.delivered
          `,
          { discard: true },
        ),
      )
      .pipe(
        Effect.andThen(
          Effect.sync(() => {
            for (const [key, row] of all) {
              if (pending.get(key) === row) pending.delete(key)
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "A notice row could not be written, and is held until a write succeeds",
            cause,
          ),
        ),
      )
  }

  /**
   * Posts a notice in the destination, trying twice, and logs it either way (FAIL-158, FAIL-160, REC-102). The model
   * of the session in that thread is told at its next turn (FAIL-131). Says whether the post was delivered.
   */
  const deliver = Effect.fnUntraced(function* (key: string, text: string) {
    const target = destination
    if (target === undefined) {
      yield* Logger.event(
        "notice.undelivered",
        "A notice could not be posted, because no session is known",
        { key, text },
      )
      return false
    }
    const where = { connection: target.connection, thread: target.thread }
    const direct = yield* directOf(target)
    const posted = yield* Effect.exit(
      Effect.suspend(() => options.post(target, direct, text)).pipe(
        Effect.sandbox,
        Effect.retry({ times: 1 }),
      ),
    )
    if (Exit.isFailure(posted)) {
      yield* Logger.event(
        "notice.undelivered",
        "A notice could not be posted, because the post failed twice",
        { key, ...where, text },
        posted.cause,
      )
      return false
    }
    yield* Logger.event("notice.sent", "A notice was posted", {
      key,
      ...where,
      text,
    })
    yield* Sessions.current(target.thread).pipe(
      Effect.flatMap((session) =>
        session === undefined
          ? Effect.void
          : Sessions.tell(session.id, { notice: key, text }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "The session could not be told of a notice it was posted in",
          cause,
        ),
      ),
    )
    return true
  })

  /**
   * Sends a key's notice while its row holds and has no delivered post, and records the send in the row. One send
   * runs at a time, so a send and the resend of FAIL-160 never post one notice twice. `again` is the resend, which
   * sends a live key only while this daemon holds it, because its row may hold from a boot whose condition passed.
   */
  const send = (key: string, again: boolean) =>
    sending.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* rows.withPermits(1)(read(key))
        if (row === undefined || !row.holds || row.delivered) return
        if (again && !isTableKey(key) && !live.has(key)) return
        const delivered = yield* deliver(key, row.text)
        yield* rows.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* read(key)
            if (now === undefined) return
            yield* write(key, {
              ...now,
              sent: delivered ? Date.now() : now.sent,
              delivered,
            })
          }),
        )
      }),
    )

  const fork = <A>(effect: Effect.Effect<A, never, SqlClient.SqlClient>) =>
    Effect.forkIn(
      Effect.provideService(effect, SqlClient.SqlClient, sql),
      scope,
    )

  /** Posts every keyed notice whose condition holds and whose last post was not delivered (FAIL-160, REC-110). */
  const resend = Effect.gen(function* () {
    const found = yield* sql<{
      key: string
    }>`SELECT key FROM notices WHERE holds = 1 AND delivered = 0`.pipe(
      Effect.orElseSucceed(() => []),
    )
    const keys = new Set([...found.map(({ key }) => key), ...pending.keys()])
    for (const key of keys) yield* send(key, true)
  })

  const raise = (notice: Notice) =>
    rows.withPermits(1)(
      Effect.gen(function* () {
        const { key, text } = notice
        if (!isTableKey(key)) live.set(key, text)
        const row = yield* read(key)
        // A condition that already holds is not announced again, whatever restarts came between (FAIL-150).
        if (row?.holds === true) {
          if (row.text !== text) yield* write(key, { ...row, text })
          return
        }
        const now = Date.now()
        const quiet =
          row?.sent !== undefined &&
          row.sent !== null &&
          now - row.sent < Duration.toMillis(options.quiet)
        yield* write(key, {
          holds: true,
          recorded: now,
          sent: row?.sent ?? null,
          text,
          delivered: quiet ? row.delivered : false,
        })
        if (quiet) return
        // With no session known the notice is logged as not delivered now, and waits for the first one (FAIL-160).
        if (destination === undefined) {
          yield* deliver(key, text).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          )
        } else yield* fork(send(key, false))
      }),
    )

  const clear = (key: string) =>
    rows.withPermits(1)(
      Effect.gen(function* () {
        live.delete(key)
        const row = yield* read(key)
        if (row?.holds === true) yield* write(key, { ...row, holds: false })
      }),
    )

  const arrived = (at: Destination & { readonly direct: boolean }) =>
    moves.withPermits(1)(
      Effect.gen(function* () {
        const now = destination
        const same =
          now?.connection === at.connection && now.thread === at.thread
        if (same && !unwritten) return
        // A direct message session stays the destination while the owner writes elsewhere (REC-101).
        if (
          !same &&
          now !== undefined &&
          !at.direct &&
          (yield* directOf(now, platformWait))
        ) {
          return
        }
        destination = at
        const wrote = yield* Effect.exit(
          writeDestination(options.data, at).pipe(
            Effect.provideContext(services),
          ),
        )
        unwritten = Exit.isFailure(wrote)
        if (Exit.isFailure(wrote)) {
          yield* Effect.logWarning(
            "state/notice-thread could not be written",
            wrote.cause,
          )
        }
        // The first session chad knows gets the notices that had nowhere to go (FAIL-160).
        if (now === undefined) yield* fork(resend)
      }),
    )

  const held = sql<{
    key: string
    text: string
    recorded_at: number | null
  }>`SELECT key, text, recorded_at FROM notices WHERE holds = 1`.pipe(
    Effect.map((found) => {
      const table = new Map(
        found.map((row) => [
          row.key,
          { text: row.text, recorded: row.recorded_at, holds: true },
        ]),
      )
      for (const [key, row] of pending) table.set(key, row)
      return [...table]
        .filter(([key, row]) => row.holds && isTableKey(key))
        .map(([, row]) => Messages.heldProblem(row.text, row.recorded ?? 0))
    }),
  )

  return Notices.of({
    raise,
    clear,
    arrived,
    problems: () => [...live.values()],
    held,
  })
})
