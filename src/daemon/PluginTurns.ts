import { randomUUID } from "node:crypto"
import { Cause, Effect, Option, Stream } from "effect"
import { ChatThread } from "effect/chat"
import * as Messages from "../Messages.ts"
import { CurrentSession } from "../Session.ts"
import { Turns } from "../Turns.ts"
import type { Chats, ChatService } from "./Chats.ts"
import type { Connection } from "./Connection.ts"
import { PluginTurn, publicOutcome, Session } from "./SessionEntity.ts"

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
      const chat = yield* chats.get(connection.name)
      const found = yield* Effect.exit(chat.descriptor(platform))
      if (found._tag === "Success") return connection.name
    }
    return undefined
  })

/** The client of the `Session` entity, as `Session.client` gives it. */
export type Client = Effect.Success<typeof Session.client>

/**
 * The `Turns` of one plugin (06-plugin-api.md, "Starting a turn"). A call saves a persisted `plugin` request on the
 * thread's session entity, which runs the turn once the session is idle. A call that cannot save its request dies with
 * a message for the model (API-129, API-130, API-135).
 */
export const make =
  (options: {
    readonly client: Client
    readonly chats: Chats["Service"]
    readonly connections: () => ReadonlyArray<Connection>
  }) =>
  (plugin: string): Turns["Service"] => {
    const request = (
      what: "started" | "queued",
      turn: {
        readonly thread: ChatThread.ChatThread
        readonly prompt: string
        readonly label: string
        readonly mention?: string | undefined
      },
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
            // Every call is a turn of its own (API-73, CRON-99).
            key: `start/${randomUUID()}`,
            connection,
            plugin,
            label: turn.label,
            prompt: turn.prompt,
            ...(turn.mention === undefined ? {} : { mention: turn.mention }),
          }),
        }
      })
    const unsaved =
      (what: "started" | "queued") => (cause: Cause.Cause<unknown>) =>
        Effect.die(
          new Error(
            Messages.turnNotSaved(
              what,
              Messages.firstLine(Cause.pretty(cause)),
            ),
          ),
        )
    const timers = Effect.die(
      new Error("Timers arrive with chad's timers-cron slice."),
    )
    return Turns.of({
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
          const { entity, payload } = yield* request("started", turn)
          const outcome = yield* entity
            .plugin(payload)
            .pipe(Effect.catchCause(unsaved("started")))
          return publicOutcome(outcome)
        }),
      queue: (turn) =>
        Effect.gen(function* () {
          const { entity, payload } = yield* request("queued", turn)
          yield* entity
            .plugin(payload, { discard: true })
            .pipe(Effect.catchCause(unsaved("queued")))
        }),
      schedule: () => timers,
      cancel: () => timers,
      scheduled: () => timers,
    })
  }

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
