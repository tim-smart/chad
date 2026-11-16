import { Effect, Exit, FileSystem } from "effect"
import type { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import * as Connections from "../Connections.ts"
import type * as Chats from "./Chats.ts"
import { shardTable } from "./Discord.ts"
import * as Queue from "./Queue.ts"
import type { Volume } from "./Volume.ts"

/**
 * The `connection` and `owner` commands as the running daemon makes them. The daemon holds the lock, so it is the
 * one writer of `secrets/connections.json`, and what it writes there it loads at once.
 */
export interface Commands {
  /** Makes a change, for the caller a `command.ran` line names. */
  readonly change: (
    change: Connections.Change,
    caller: string,
  ) => Effect.Effect<Connections.Changed, Connections.Rejected>
  readonly list: Effect.Effect<ReadonlyArray<Connections.Listed>>
  readonly check: (
    name: string | undefined,
  ) => Effect.Effect<ReadonlyArray<Connections.Checked>, Connections.Rejected>
}

/** The name of the connection a row of shard state belongs to, which is its key up to the first `/`. */
const ownerOf = (key: string): string => key.slice(0, key.indexOf("/"))

/** The keys of the shard state table, or none when no Discord connection has made the table yet. */
const shardKeys = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${shardTable}`
  if (tables.length === 0) return []
  const rows = yield* sql<{
    id: string
  }>`SELECT id FROM ${sql(shardTable)}`
  return rows.map((row) => row.id)
})

/** Deletes the rows of shard state that belong to a connection `gone` says is gone. */
const deleteShardState = (gone: (connection: string) => boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const key of yield* shardKeys) {
      if (gone(ownerOf(key))) {
        yield* sql`DELETE FROM ${sql(shardTable)} WHERE id = ${key}`
      }
    }
  }).pipe(Effect.orDie)

/** The boot's cleanup: the rows of every connection that is no longer stored go. */
export const forget = (stored: ReadonlyArray<Connections.Connection>) =>
  deleteShardState(
    (name) => !stored.some((connection) => connection.name === name),
  )

export const make = Effect.fnUntraced(function* <R>(
  volume: Volume,
  /** What `chad status` reads the connections from. */
  state: {
    connections: ReadonlyArray<{ readonly name: string; readonly kind: string }>
  },
  running: Chats.Running<R>,
  queue: Queue.Queue,
  /**
   * Rebuilds the plugins after the owners changed, already inside the queue. With an owner removed, a plugin that fails
   * to rebuild is unloaded, so it cannot keep answering the removed person (CLI-120b). It is called where nothing
   * interrupts the caller, so it has to run its work on a fiber that a stop can interrupt.
   */
  owners: (removed: boolean) => Effect.Effect<void> = () => Effect.void,
) {
  const context = yield* Effect.context<
    R | HttpClient.HttpClient | SqlClient.SqlClient | FileSystem.FileSystem
  >()
  let connections = running.list()

  const made = (change: Connections.Change, application: string | undefined) =>
    Effect.gen(function* () {
      // The list may have moved while the platform was asked, so the change is made on the list as it stands now.
      const next = yield* Connections.apply(connections, change)
      if (next.changed) {
        // A client that goes away now does not leave the file, the running connections and the plugins' owners apart.
        // The rebuild runs on a fiber of the daemon's scope, which a stop still interrupts (CLI-120b, SWAP-99).
        yield* Effect.gen(function* () {
          yield* Effect.orDie(Connections.write(volume.data, next.connections))
          connections = next.connections
          state.connections = Connections.listed(connections)
          yield* running.set(next.connections)
          if (change._tag === "Remove") {
            yield* deleteShardState((name) => name === change.name)
          }
          if (change._tag !== "Add" && change._tag !== "Token") {
            yield* owners(change._tag !== "OwnerAdd")
          }
        }).pipe(Effect.uninterruptible)
      }
      return application === undefined
        ? { changed: next.changed }
        : { changed: next.changed, application }
    })

  const commands: Commands = {
    change: (change, caller) =>
      Effect.gen(function* () {
        // The platform is asked before the change takes its place, so the queue is never held while chad waits on it.
        const checked = yield* Connections.prepare(connections, change)
        return yield* queue.run(made(change, checked.application))
      }).pipe(
        Effect.onExit((exit) => {
          const command = Connections.commandOf(change)
          const fields = { connection: change.name }
          if (Exit.isSuccess(exit)) {
            return Queue.ran(
              command,
              caller,
              exit.value.changed ? "changed" : "unchanged",
              fields,
            )
          }
          const error = Exit.findErrorOption(exit)
          return error._tag === "Some"
            ? Queue.ran(command, caller, "refused", {
                ...fields,
                reason: error.value.reason,
              })
            : Effect.void
        }),
        Effect.provide(context),
      ),
    list: Effect.sync(() => Connections.listed(connections)),
    check: (name) =>
      Connections.check(connections, volume.data, name).pipe(
        Effect.provide(context),
      ),
  }
  return commands
})
