import { Context, Deferred, Effect } from "effect"
import type { Chat } from "effect/chat"
import type { Connection } from "./Connection.ts"

/** effect/chat's router, as one connection has it. */
export type ChatService = Chat.Chat["Service"]

/**
 * The `Chat` of each chat connection, by the connection's name. effect/chat's adapter registry is keyed by platform,
 * and two connections can share a platform, so each connection has a registry and a `Chat` of its own and a session
 * posts through the one its message arrived on.
 */
export class Chats extends Context.Service<
  Chats,
  {
    /** Called once by a connection when its `Chat` is built. */
    readonly register: (
      connection: string,
      chat: ChatService,
    ) => Effect.Effect<void>
    /** The `Chat` of a connection, once it is built. It dies for a name that is no connection of this daemon. */
    readonly get: (connection: string) => Effect.Effect<ChatService>
  }
>()("chad/Chats") {}

export const make = (connections: ReadonlyArray<Connection>) =>
  Effect.gen(function* () {
    const chats = new Map<string, Deferred.Deferred<ChatService>>()
    for (const connection of connections) {
      chats.set(connection.name, yield* Deferred.make<ChatService>())
    }
    const find = (connection: string) => {
      const chat = chats.get(connection)
      return chat === undefined
        ? Effect.die(new Error(`there is no chat connection ${connection}`))
        : Effect.succeed(chat)
    }
    return Chats.of({
      register: (connection, chat) =>
        Effect.flatMap(find(connection), (deferred) =>
          Effect.asVoid(Deferred.succeed(deferred, chat)),
        ),
      get: (connection) => Effect.flatMap(find(connection), Deferred.await),
    })
  })
