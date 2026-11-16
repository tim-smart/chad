import {
  Cause,
  Context,
  Cron,
  DateTime,
  Effect,
  Option,
  PrimaryKey,
  Result,
  Schema,
} from "effect"
import { ChatThread } from "effect/chat"
import {
  ClusterSchema,
  DeliverAt,
  Entity,
  EntityAddress,
  EntityId,
  MessageStorage,
  Sharding,
} from "effect/cluster"
import { Rpc } from "effect/rpc"
import { SqlClient } from "effect/sql"
import * as Messages from "../Messages.ts"
import type { Timer as PublicTimer } from "../Turns.ts"
import * as Logger from "./Logger.ts"
import type { Outcome } from "./SessionEntity.ts"

// The timers of docs/spec/13-timers-and-cron.md. A timer is a `timers` row, which says whether a run is still wanted,
// and one persisted wake-up at the timer's own address of the `Timer` entity, which says when to look (CRON-12 to
// CRON-16, STO-78).

/** A `timers` row (STO-77). `cron` and `timezone` are null for a one-shot. */
export interface Row {
  readonly plugin: string
  readonly name: string
  readonly cron: string | null
  readonly timezone: string | null
  readonly thread: string
  readonly prompt: string
  readonly label: string
  readonly mention: string | null
  readonly next_run: number
}

/** The wake-up of one scheduled run. One scheduled time at one address is one request (CRON-97). */
export class Fire extends Schema.Class<Fire>("chad/Timer/Fire")({
  plugin: Schema.String,
  name: Schema.String,
  at: Schema.Number,
}) {
  [PrimaryKey.symbol]() {
    return String(this.at)
  }
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at)
  }
}

/** The `Timer` entity, next to `Session` and never sharing its addresses (CRON-12, CRON-13). */
export const Timer = Entity.make("Timer", [
  Rpc.make("fire", { payload: Fire }).annotate(ClusterSchema.Persisted, true),
])

/** The entity id of a timer (CRON-96). */
export const entityId = (plugin: string, name: string) => `${plugin}/${name}`

/** The turn key of a scheduled run, which makes one scheduled time one turn (CRON-20, CRON-98, SES-16). */
export const turnKey = (plugin: string, name: string, at: number) =>
  `timer/${plugin}/${name}/${at}`

/**
 * The next run of a cron expression after a time, by Effect's `Cron` with its default daylight saving behaviour, and
 * no next-run code of chad's own (CRON-100 to CRON-103). A 6-field expression has seconds first (CRON-139).
 */
export const next = (
  cron: string,
  timezone: string,
  after: number,
): Result.Result<number, string> =>
  Result.map(
    Result.mapError(Cron.parse(cron, timezone), (error) => error.message),
    (parsed) => Cron.next(parsed, after).getTime(),
  )

/** What the handler needs of the daemon, which hands it over once the plugins and the sessions are there. */
export const Support = Context.Reference<{
  readonly active: (plugin: string) => boolean
  readonly whenActive: (plugin: string) => Effect.Effect<void>
  /** Runs the row's turn under the key of its scheduled run, and gives its outcome once the session has it. */
  readonly run: (row: Row, at: number) => Effect.Effect<Outcome>
}>("chad/Timers/Support", {
  defaultValue: () => ({
    active: () => false,
    whenActive: () => Effect.never,
    run: () => Effect.die(new Error("The timers' support is not set")),
  }),
})

export const read = Effect.fnUntraced(function* (plugin: string, name: string) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql<Row>`SELECT * FROM timers WHERE plugin = ${plugin} AND name = ${name}`
  return rows[0]
})

/** Every timer of one plugin, by name. */
export const list = Effect.fnUntraced(function* (plugin: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<Row>`SELECT * FROM timers WHERE plugin = ${plugin} ORDER BY name`
})

/** How many timers each plugin has, and how many of them are due by `now`. */
export const counts = Effect.fnUntraced(function* (now: number) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    readonly plugin: string
    readonly count: number | bigint
    readonly overdue: number | bigint | null
  }>`SELECT plugin, COUNT(*) AS count, SUM(next_run <= ${now}) AS overdue FROM timers GROUP BY plugin ORDER BY plugin`
  return rows.map((row) => ({
    plugin: row.plugin,
    count: Number(row.count),
    overdue: Number(row.overdue ?? 0),
  }))
})

/** A row as `Turns.scheduled()` gives it, without the plugin (CRON-92, API-122). */
export const toPublic = (row: Row): PublicTimer => ({
  name: row.name,
  schedule:
    row.cron === null
      ? { at: DateTime.makeUnsafe(row.next_run) }
      : { cron: row.cron, timezone: row.timezone ?? "UTC" },
  thread: Option.getOrElse(
    ChatThread.fromString(row.thread),
    () =>
      ({ platform: "", id: row.thread }) as unknown as ChatThread.ChatThread,
  ),
  prompt: row.prompt,
  label: row.label,
  ...(row.mention === null ? {} : { mention: row.mention }),
  nextRun: DateTime.makeUnsafe(row.next_run),
})

/** The timers' storage and wake-ups, over the daemon's database and cluster. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const storage = yield* MessageStorage.MessageStorage
  const sharding = yield* Sharding.Sharding
  const client = yield* Timer.client
  const address = (plugin: string, name: string) => {
    const id = EntityId.make(entityId(plugin, name))
    return EntityAddress.make({
      entityType: Timer.type,
      entityId: id,
      shardId: sharding.getShardId(id, Timer.getShardGroup(id)),
    })
  }
  /** Saves the wake-up of a row's next run. One that is stored already is the same request, so this can run again. */
  const arm = (row: Pick<Row, "plugin" | "name" | "next_run">) =>
    client(entityId(row.plugin, row.name)).fire(
      new Fire({ plugin: row.plugin, name: row.name, at: row.next_run }),
      { discard: true },
    )
  /** Deletes every wake-up stored at the timer's address, the way the workflow engine clears a clock (CRON-16). */
  const clear = (plugin: string, name: string) =>
    storage.clearAddress(address(plugin, name))
  return {
    arm,
    clear,
    /**
     * Stores a timer and its one wake-up: the row is overwritten, the earlier wake-up cleared and the new one saved, so
     * only the new time fires (CRON-6). The three are one transaction, so a change that cannot be saved leaves the
     * earlier timer as it was (API-133).
     */
    save: (row: Row) =>
      storage.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO timers ${sql.insert({ ...row })} ON CONFLICT (plugin, name) DO UPDATE SET cron = excluded.cron, timezone = excluded.timezone, thread = excluded.thread, prompt = excluded.prompt, label = excluded.label, mention = excluded.mention, next_run = excluded.next_run`
          yield* clear(row.plugin, row.name)
          yield* arm(row)
        }),
      ),
    /** Removes a timer's row and its wake-ups. A run that has started finishes and saves nothing (CRON-7, CRON-16). */
    remove: (plugin: string, name: string) =>
      storage.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM timers WHERE plugin = ${plugin} AND name = ${name}`
          yield* clear(plugin, name)
        }),
      ),
    /** Removes every timer of a plugin, for `chad plugin purge`, and gives how many there were (CRON-35). */
    purge: (plugin: string) =>
      storage.withTransaction(
        Effect.gen(function* () {
          const rows = yield* list(plugin)
          yield* sql`DELETE FROM timers WHERE plugin = ${plugin}`
          for (const row of rows) yield* clear(plugin, row.name)
          return rows.length
        }),
      ),
    /**
     * Saves the wake-up of every row again, at boot. A wake-up already stored is the same request and changes nothing,
     * so a kill between writing a row and saving its wake-up loses no run.
     */
    rearm: Effect.gen(function* () {
      const rows = yield* sql<Row>`SELECT * FROM timers`
      for (const row of rows) yield* arm(row)
    }),
  }
})

export type Timers = Effect.Success<typeof make>

/**
 * The handler of a wake-up. It reads the row, waits while the plugin is not loaded, runs the turn and waits for its end,
 * reads the row again and only then stores the next run (CRON-15, CRON-19 to CRON-25, CRON-30 to CRON-32).
 */
export const layer = Timer.toLayer(
  Effect.gen(function* () {
    const support = yield* Support
    const sql = yield* SqlClient.SqlClient
    const storage = yield* MessageStorage.MessageStorage
    const client = yield* Timer.client
    return Timer.of({
      fire: ({ payload }) =>
        Effect.gen(function* () {
          const { plugin, name, at } = payload
          const wanted = (row: Row | undefined): row is Row =>
            row !== undefined && row.next_run === at
          const row = yield* read(plugin, name)
          if (!wanted(row)) return
          // A plugin that is not loaded, is off or is in a swap holds the run inside this request (CRON-30, CRON-40).
          let current = row
          if (!support.active(plugin)) {
            yield* Logger.event(
              "timer.held",
              "A timer came due for a plugin that is not loaded",
              { plugin, timer: name },
            )
            yield* support.whenActive(plugin)
            const again = yield* read(plugin, name)
            if (!wanted(again)) return
            current = again
          }
          // A run that dies is logged and not run again, and the chain goes on, so one bad run never ends a recurring
          // timer (FAIL-71).
          yield* support
            .run(current, at)
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logError("A timer's run failed", cause).pipe(
                      Effect.annotateLogs({ plugin, timer: name }),
                    ),
              ),
            )
          // A cancel or a replace during the run stays in force (CRON-23).
          const after = yield* read(plugin, name)
          if (!wanted(after)) return
          if (after.cron === null) {
            yield* sql`DELETE FROM timers WHERE plugin = ${plugin} AND name = ${name} AND next_run = ${at}`
            return
          }
          // The next run is the first time after the turn ended, so missed times never fire in a burst (CRON-100).
          const following = next(
            after.cron,
            after.timezone ?? "UTC",
            Date.now(),
          )
          if (Result.isFailure(following)) {
            return yield* Effect.die(new Error(following.failure))
          }
          // The row and the next wake-up are saved together, so the row never names a run nothing will wake.
          yield* storage.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE timers SET next_run = ${following.success} WHERE plugin = ${plugin} AND name = ${name} AND next_run = ${at}`
              yield* client(entityId(plugin, name)).fire(
                new Fire({ plugin, name, at: following.success }),
                { discard: true },
              )
            }),
          )
        }).pipe(Effect.orDie),
    })
  }),
  // A defect fails that one request, and the entity carries on (SES-20).
  { disableFatalDefects: true },
)

/** The defect a `Turns.schedule` or `Turns.cancel` dies with when its change cannot be saved (API-133). */
export const unsaved = (why: string) =>
  Effect.die(new Error(Messages.timerNotSaved(why)))
