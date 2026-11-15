import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { Chat } from "effect/chat"
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
    /** The `Chat` of a connection, once it is built. It dies for a name that is no connection of this daemon. */
    readonly get: (connection: string) => Effect.Effect<ChatService>
  }
>()("chad/Chats") {}

/** A connection as its handler sees it while it runs: the name, and the owner ids as they stand at each message. */
export interface Live {
  readonly name: string
  readonly owners: () => ReadonlyArray<string>
}

/**
 * The connections that run, each in a scope of its own, so that one can be taken down or swapped while the others and
 * the sessions carry on.
 */
export interface Running<R> {
  readonly chats: Chats["Service"]
  /** The connections that run, as they are stored. */
  readonly list: () => ReadonlyArray<Connection>
  /**
   * Makes the running connections those of the list. A connection that is new is started, one that is gone is taken
   * down, one whose token changed is taken down and started with the new one, and an owner list is replaced where it
   * stands.
   */
  readonly set: (
    connections: ReadonlyArray<Connection>,
  ) => Effect.Effect<void, never, R>
}

interface Entry {
  connection: Connection
  readonly chat: Deferred.Deferred<ChatService>
  readonly scope: Scope.Closeable
}

/**
 * `layer` gives the Layer of one connection's chat platform. It is built with a `Chat` and an adapter registry that
 * no other connection shares, in a scope that lives until the connection is removed or swapped, or the daemon stops.
 */
export const make = <R>(
  layer: (
    connection: Connection,
    live: Live,
  ) => Layer.Layer<never, never, R | Layer.Success<typeof Chat.layer>>,
) =>
  Effect.gen(function* () {
    const parent = yield* Effect.scope
    const entries = new Map<string, Entry>()

    // The entry is in place before the platform is built, so a session that answers meanwhile waits for it.
    const place = Effect.fnUntraced(function* (connection: Connection) {
      const entry: Entry = {
        connection,
        chat: yield* Deferred.make<ChatService>(),
        scope: yield* Scope.fork(parent),
      }
      entries.set(connection.name, entry)
      return entry
    })

    const build = (entry: Entry) => {
      const registered = Layer.effectDiscard(
        Effect.flatMap(Chat.Chat, (chat) => Deferred.succeed(entry.chat, chat)),
      )
      const live: Live = {
        name: entry.connection.name,
        owners: () => entry.connection.owners,
      }
      return Layer.buildWithScope(
        Layer.mergeAll(registered, layer(entry.connection, live)).pipe(
          Layer.provide(Layer.fresh(Chat.layer)),
        ),
        entry.scope,
      )
    }

    const running: Running<R> = {
      chats: {
        get: (connection) => {
          const entry = entries.get(connection)
          return entry === undefined
            ? Effect.die(new Error(`there is no chat connection ${connection}`))
            : Deferred.await(entry.chat)
        },
      },
      list: () => [...entries.values()].map((entry) => entry.connection),
      set: Effect.fnUntraced(function* (connections) {
        const stale: Array<Entry> = []
        const fresh: Array<Entry> = []
        for (const entry of entries.values()) {
          const next = connections.find(
            ({ name }) => name === entry.connection.name,
          )
          if (next === undefined) {
            entries.delete(entry.connection.name)
            stale.push(entry)
          } else if (
            next.kind !== entry.connection.kind ||
            next.token !== entry.connection.token
          ) {
            // The new entry takes the old one's place first, so the connection is never unknown in between.
            stale.push(entry)
            fresh.push(yield* place(next))
          } else {
            entry.connection = next
          }
        }
        for (const connection of connections) {
          if (!entries.has(connection.name)) {
            fresh.push(yield* place(connection))
          }
        }
        // What is taken down is down before its successor comes up: a bot has one gateway session at a time.
        for (const entry of stale) yield* Scope.close(entry.scope, Exit.void)
        yield* Effect.forEach(fresh, build, {
          concurrency: "unbounded",
          discard: true,
        })
      }),
    }
    return running
  })
