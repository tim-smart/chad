import { Data, Effect, Exit, FileSystem } from "effect"
import type { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import * as Connections from "../Connections.ts"
import type * as Chats from "./Chats.ts"
import { shardTable } from "./Discord.ts"
import * as Queue from "./Queue.ts"
import type { Volume } from "./Volume.ts"

/**
 * The `connection`, `owner` and `channel` commands as the running daemon makes them. The daemon holds the lock, so it is the
 * one writer of `secrets/connections.json`, and what it writes there it loads at once.
 */
export interface Commands {
  /** Makes a change, for the caller a `command.ran` line names. */
  readonly change: (
    change: Connections.Change,
    caller: string,
  ) => Effect.Effect<Connections.Changed, Connections.Rejected>
  /**
   * Makes a change from chat, as `change` does, if `guard` still holds when its turn in the queue comes. The guard is
   * read right before the change is made, after every change queued before it, so a connection that was swapped or an
   * owner who was removed while the command waited changes nothing.
   */
  readonly guarded: (
    change: Connections.Change,
    caller: string,
    guard: () => boolean,
  ) => Effect.Effect<Connections.Changed, Connections.Rejected | Stale>
  readonly list: Effect.Effect<ReadonlyArray<Connections.Listed>>
  readonly check: (
    name: string | undefined,
  ) => Effect.Effect<ReadonlyArray<Connections.Checked>, Connections.Rejected>
}

/** A guarded change whose guard no longer held when its turn in the queue came. Nothing was changed. */
export class Stale extends Data.TaggedError("Stale")<{}> {}

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
   * to rebuild is unloaded, so it cannot keep answering the removed person. It is called where nothing
   * interrupts the caller, so it has to run its work on a fiber that a stop can interrupt.
   */
  owners: (removed: boolean) => Effect.Effect<void> = () => Effect.void,
) {
  const context = yield* Effect.context<
    R | HttpClient.HttpClient | SqlClient.SqlClient | FileSystem.FileSystem
  >()
  let connections = running.list()

  const made = (
    change: Connections.Change,
    application: string | undefined,
    guard: () => boolean,
  ) =>
    Effect.gen(function* () {
      if (!guard()) return yield* new Stale()
      // The list may have moved while the platform was asked, so the change is made on the list as it stands now.
      const next = yield* Connections.apply(connections, change)
      if (next.changed) {
        // A client that goes away now does not leave the file, the running connections and the plugins' owners apart.
        // The rebuild runs on a fiber of the daemon's scope, which a stop still interrupts.
        yield* Effect.gen(function* () {
          yield* Effect.orDie(Connections.write(volume.data, next.connections))
          connections = next.connections
          state.connections = Connections.listed(connections)
          yield* running.set(next.connections)
          if (change._tag === "Remove") {
            yield* deleteShardState((name) => name === change.name)
          }
          // A channel list changes no one's access, so only a change to who the owners are rebuilds the plugins.
          if (
            change._tag === "Remove" ||
            change._tag === "OwnerAdd" ||
            change._tag === "OwnerRemove"
          ) {
            yield* owners(change._tag !== "OwnerAdd")
          }
        }).pipe(Effect.uninterruptible)
      }
      return application === undefined
        ? { changed: next.changed }
        : { changed: next.changed, application }
    })

  const run = (
    change: Connections.Change,
    caller: string,
    guard: () => boolean,
  ) =>
    Effect.gen(function* () {
      // The platform is asked before the change takes its place, so the queue is never held while chad waits on it.
      const checked = yield* Connections.prepare(connections, change)
      return yield* queue.run(made(change, checked.application, guard))
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
              reason:
                error.value._tag === "Stale" ? "stale" : error.value.reason,
            })
          : Effect.void
      }),
      Effect.provide(context),
    )

  const commands: Commands = {
    // A change with no guard is never stale.
    change: (change, caller) =>
      run(change, caller, () => true).pipe(
        Effect.catchTag("Stale", (stale) => Effect.die(stale)),
      ),
    guarded: run,
    list: Effect.sync(() => Connections.listed(connections)),
    check: (name) =>
      Connections.check(connections, volume.data, name).pipe(
        Effect.provide(context),
      ),
  }
  return commands
})
