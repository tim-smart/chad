import { randomUUID } from "node:crypto"
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Option,
  Result,
  Scope,
  Stream,
} from "effect"
import { ChatThread } from "effect/chat"
import * as Messages from "../Messages.ts"
import { CurrentSession } from "../Session.ts"
import { Turns } from "../Turns.ts"
import type { Chats, ChatService } from "./Chats.ts"
import type { Connection } from "./Connection.ts"
import type { SqlClient } from "effect/sql"
import {
  type Outcome,
  PluginTurn,
  publicOutcome,
  Session,
} from "./SessionEntity.ts"
import * as Sessions from "./Sessions.ts"
import * as Timers from "./Timers.ts"

/** The `Turns.start` calls that wait in this process, by their request's key. The session resolves them (SES-125). */
export type Waiting = Map<string, Deferred.Deferred<Outcome>>

/** Resolves the call that waits on a request, if one does. */
export const ended = (waiting: Waiting, key: string, outcome: Outcome) => {
  const waiter = waiting.get(key)
  if (waiter !== undefined) Deferred.doneUnsafe(waiter, Effect.succeed(outcome))
}

/**
 * The connection whose platform has a thread: the first running connection whose `Chat` has an adapter for the
 * thread's platform. One owner on one server has one connection of each platform.
 */
const connectionOf = (
  chats: Chats["Service"],
  connections: () => ReadonlyArray<Connection>,
  platform: string,
) =>
  Effect.gen(function* () {
    for (const connection of connections()) {
      // A timer released as the daemon boots can run before the connection's adapter registers (CRON-26).
      yield* chats.ready(connection.name)
      const chat = yield* chats.get(connection.name)
      const found = yield* Effect.exit(chat.descriptor(platform))
      if (found._tag === "Success") return connection.name
    }
    return undefined
  })

/** The client of the `Session` entity, as `Session.client` gives it. */
export type Client = Effect.Success<typeof Session.client>

/** A turn as a plugin asks for one. */
interface Asked {
  readonly thread: ChatThread.ChatThread
  readonly prompt: string
  readonly label: string
  readonly mention?: string | undefined
}

/** What the `Turns` of every plugin share. */
export interface Options {
  readonly client: Client
  readonly chats: Chats["Service"]
  readonly connections: () => ReadonlyArray<Connection>
  readonly waiting: Waiting
  /** Where a call's request runs while its caller waits, which outlives the caller once the turn has ended. */
  readonly scope: Scope.Scope
  /** The timers' rows and wake-ups, over which `schedule`, `cancel` and `scheduled` run. */
  readonly timers: Timers.Timers
  /** Runs an effect that reads the database, which a plugin's own context has no access to. */
  readonly database: <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient>,
  ) => Effect.Effect<A, E>
}

/** The request of a plugin's turn and the session entity it goes to. */
const request = (
  options: Options,
  plugin: string,
  what: "started" | "queued",
  turn: Asked,
  key: string,
  timer?: { readonly name: string; readonly scheduledAt: number },
) =>
  Effect.gen(function* () {
    const connection = yield* connectionOf(
      options.chats,
      options.connections,
      turn.thread.platform,
    )
    if (connection === undefined) {
      return yield* Effect.die(
        new Error(
          Messages.turnNotSaved(
            what,
            `no chat connection has the platform ${turn.thread.platform}`,
          ),
        ),
      )
    }
    return {
      entity: options.client(ChatThread.toString(turn.thread)),
      payload: new PluginTurn({
        key,
        connection,
        plugin,
        label: turn.label,
        prompt: turn.prompt,
        ...(turn.mention === undefined ? {} : { mention: turn.mention }),
        ...(timer === undefined ? {} : { timer }),
      }),
    }
  })

const unsaved = (what: "started" | "queued") => (cause: Cause.Cause<unknown>) =>
  Effect.die(
    new Error(
      Messages.turnNotSaved(what, Messages.firstLine(Cause.pretty(cause))),
    ),
  )

/**
 * Saves a plugin turn's request and waits for its outcome, from whichever is first: the session's own record of the
 * end, or cluster's reply. A reply that cannot be saved never comes, and the call returns all the same (SES-125,
 * API-100, CRON-84, FAIL-141). The request's fiber is left to finish, because interrupting it would interrupt the
 * request. A request whose turn has already ended is answered from its row, which a timer's wake-up delivered again
 * after a kill relies on (CRON-29).
 */
const run = (
  options: Options,
  plugin: string,
  turn: Asked,
  key: string,
  timer?: { readonly name: string; readonly scheduledAt: number },
) =>
  Effect.gen(function* () {
    const { entity, payload } = yield* request(
      options,
      plugin,
      "started",
      turn,
      key,
      timer,
    )
    const waiter = Deferred.makeUnsafe<Outcome>()
    options.waiting.set(payload.key, waiter)
    const call = yield* entity.plugin(payload).pipe(
      Effect.catchCause(unsaved("started")),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(waiter, exit)),
      Effect.forkIn(options.scope),
    )
    return yield* Deferred.await(waiter).pipe(
      Effect.onInterrupt(() => Fiber.interrupt(call)),
      Effect.ensuring(Effect.sync(() => options.waiting.delete(payload.key))),
    )
  })

/**
 * Runs a timer's turn, as the `Timer` entity's handler asks: the row's thread, prompt, label and mention under the key
 * of the scheduled run, with the timer on the turn's origin (CRON-9, CRON-19, CRON-20).
 */
export const runTimer = (options: Options) => (row: Timers.Row, at: number) =>
  Effect.gen(function* () {
    const key = Timers.turnKey(row.plugin, row.name, at)
    // A run whose turn ended before a kill gets its outcome from the row and starts nothing (CRON-29).
    const ended = yield* options.database(Sessions.turn(key)).pipe(Effect.orDie)
    if (ended !== undefined && ended.outcome !== null) {
      return { _tag: "Stopped" } as Outcome
    }
    const thread = ChatThread.fromString(row.thread)
    if (Option.isNone(thread)) {
      return yield* Effect.die(new Error(`${row.thread} is not a thread`))
    }
    return yield* run(
      options,
      row.plugin,
      {
        thread: thread.value,
        prompt: row.prompt,
        label: row.label,
        mention: row.mention ?? undefined,
      },
      key,
      { name: row.name, scheduledAt: at },
    )
  })

/**
 * The `Turns` of one plugin (06-plugin-api.md, "Starting a turn" and "Scheduling a turn"). A call saves a persisted
 * `plugin` request on the thread's session entity, which runs the turn once the session is idle, or a timer's row and
 * its wake-up. A call that cannot save what it asked for dies with a message for the model (API-129, API-130, API-133,
 * API-135).
 */
export const make =
  (options: Options) =>
  (plugin: string): Turns["Service"] =>
    Turns.of({
      start: (turn) =>
        Effect.gen(function* () {
          // A tool's own turn would wait for the turn it asks for, so the call fails at once (API-79).
          const current = yield* Effect.serviceOption(CurrentSession)
          if (
            Option.isSome(current) &&
            ChatThread.equals(current.value.session.thread, turn.thread) &&
            Option.isSome(yield* current.value.turn)
          ) {
            return yield* Effect.die(new Error(Messages.startInOwnThread))
          }
          // Every call is a turn of its own (API-73, CRON-99).
          const outcome = yield* run(
            options,
            plugin,
            turn,
            `start/${randomUUID()}`,
          )
          return publicOutcome(outcome)
        }),
      queue: (turn) =>
        Effect.gen(function* () {
          const { entity, payload } = yield* request(
            options,
            plugin,
            "queued",
            turn,
            `start/${randomUUID()}`,
          )
          yield* entity
            .plugin(payload, { discard: true })
            .pipe(Effect.catchCause(unsaved("queued")))
        }),
      schedule: (timer) =>
        Effect.gen(function* () {
          const now = Date.now()
          const recurring = "cron" in timer
          const nextRun = recurring
            ? Timers.next(timer.cron, timer.timezone, now)
            : Result.succeed(DateTime.toEpochMillis(timer.at))
          if (Result.isFailure(nextRun)) {
            return yield* Effect.die(
              new Error(Messages.timerInvalid(nextRun.failure)),
            )
          }
          yield* options
            .database(
              options.timers.save({
                plugin,
                name: timer.name,
                cron: recurring ? timer.cron : null,
                timezone: recurring ? timer.timezone : null,
                thread: ChatThread.toString(timer.thread),
                prompt: timer.prompt,
                label: timer.label,
                mention: timer.mention ?? null,
                next_run: nextRun.success,
              }),
            )
            .pipe(Effect.catchCause(timerUnsaved))
        }),
      cancel: (name) =>
        options
          .database(options.timers.remove(plugin, name))
          .pipe(Effect.catchCause(timerUnsaved)),
      scheduled: () =>
        options.database(Timers.list(plugin)).pipe(
          Effect.map((rows) => rows.map(Timers.toPublic)),
          Effect.orDie,
        ),
    })

const timerUnsaved = (cause: Cause.Cause<unknown>) =>
  Timers.unsaved(Messages.firstLine(Cause.pretty(cause)))

/**
 * The `Chat` a plugin posts through: effect/chat's router, each call sent to the connection whose platform has the
 * thread (API-18).
 */
export const chat = (
  chats: Chats["Service"],
  connections: () => ReadonlyArray<Connection>,
): ChatService => {
  const pick = (first: unknown) =>
    Effect.gen(function* () {
      const platform =
        typeof first === "string"
          ? first
          : ((
              first as {
                readonly platform?: string
                readonly thread?: { readonly platform: string }
              }
            ).platform ??
            (first as { readonly thread?: { readonly platform: string } })
              .thread?.platform)
      const name =
        platform === undefined
          ? undefined
          : yield* connectionOf(chats, connections, platform)
      return yield* chats.get(name ?? connections()[0]?.name ?? "")
    })
  const streams = new Set(["history", "download"])
  return new Proxy({} as ChatService, {
    get: (_, method) => {
      if (typeof method !== "string") return undefined
      return (...args: ReadonlyArray<unknown>) => {
        const call = (chat: ChatService) =>
          (
            chat[method as keyof ChatService] as (
              ...args: ReadonlyArray<unknown>
            ) => unknown
          )(...args)
        return streams.has(method)
          ? Stream.unwrap(
              Effect.map(
                pick(args[0]),
                (chat) => call(chat) as Stream.Stream<unknown, unknown>,
              ),
            )
          : Effect.flatMap(
              pick(args[0]),
              (chat) => call(chat) as Effect.Effect<unknown, unknown>,
            )
      }
    },
  })
}
