import {
  Cause,
  Context,
  Cron,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
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
import { Outcome, Session } from "./SessionEntity.ts"

// A timer is a `timers` row, which says whether a run is still wanted, and one persisted wake-up at the timer's own
// address of the `Timer` entity, which says when to look.

/** A `timers` row. `cron` and `timezone` are null for a one-shot. */
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

/** The wake-up of one scheduled run. One scheduled time at one address is one request. */
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

/** The `Timer` entity, next to `Session` and never sharing its addresses. */
export const Timer = Entity.make("Timer", [
  Rpc.make("fire", { payload: Fire }).annotate(ClusterSchema.Persisted, true),
])

/**
 * One run of a timer, as its `TimerRuns` entity takes it: a scheduled run, which has `scheduledAt`, or a run that
 * `Turns.queue` asked for with the timer's name. One key is one turn.
 */
export class Queued extends Schema.Class<Queued>("chad/TimerRuns/Run")({
  key: Schema.String,
  plugin: Schema.String,
  name: Schema.String,
  thread: Schema.String,
  prompt: Schema.String,
  label: Schema.String,
  mention: Schema.optionalKey(Schema.String),
  scheduledAt: Schema.optionalKey(Schema.Number),
}) {
  [PrimaryKey.symbol]() {
    return this.key
  }
}

/**
 * The runs of one timer, at the timer's entity id. The entity takes one request at a time in the order they were saved,
 * so the timer's scheduled runs and the turns queued for it run one at a time, across threads and across a kill, and
 * a cancel or a replace of the timer, which clears the `Timer` address, leaves them.
 */
export const TimerRuns = Entity.make("TimerRuns", [
  Rpc.make("run", { payload: Queued, success: Outcome }).annotate(
    ClusterSchema.Persisted,
    true,
  ),
])

/** The entity id of a timer. */
export const entityId = (plugin: string, name: string) => `${plugin}/${name}`

/** The turn key of a scheduled run, which makes one scheduled time one turn. */
export const turnKey = (plugin: string, name: string, at: number) =>
  `timer/${plugin}/${name}/${at}`

/**
 * The next run of a cron expression after a time, by Effect's `Cron` with its default daylight saving behaviour, and
 * no next-run code of chad's own. A 6-field expression has seconds first.
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
  /** Runs a timer's run as its turn, and gives the outcome once the session has it. */
  readonly run: (run: Queued) => Effect.Effect<Outcome>
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

/** A row as `Turns.scheduled()` gives it, without the plugin. */
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
  /** Deletes every wake-up stored at the timer's address, the way the workflow engine clears a clock. */
  const clear = (plugin: string, name: string) =>
    storage.clearAddress(address(plugin, name))
  return {
    arm,
    clear,
    /**
     * Stores a timer and its one wake-up: the row is overwritten, the earlier wake-up cleared and the new one saved, so
     * only the new time fires. The three are one transaction, so a change that cannot be saved leaves the earlier
     * timer as it was.
     */
    save: (row: Row) =>
      storage.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO timers ${sql.insert({ ...row })} ON CONFLICT (plugin, name) DO UPDATE SET cron = excluded.cron, timezone = excluded.timezone, thread = excluded.thread, prompt = excluded.prompt, label = excluded.label, mention = excluded.mention, next_run = excluded.next_run`
          yield* clear(row.plugin, row.name)
          yield* arm(row)
        }),
      ),
    /** Removes a timer's row and its wake-ups. A run that has started finishes and saves nothing. */
    remove: (plugin: string, name: string) =>
      storage.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM timers WHERE plugin = ${plugin} AND name = ${name}`
          yield* clear(plugin, name)
        }),
      ),
    /** Removes every timer of a plugin, for `chad plugin purge`, and gives how many there were. */
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
 * The ends of the scheduled runs of this process, by the run's turn key. The `TimerRuns` handler gives each run's end
 * here as well as in its reply, so a reply that cannot be saved does not stop the chain. Either side makes
 * the entry: the wake-up's handler when it starts, or the run's handler when the run ends first, as a run replayed
 * after a restart can while its wake-up is held. The wake-up's handler removes it on every exit.
 */
type Ends = Map<string, Deferred.Deferred<Outcome>>

/** The end of a run, made when neither side has asked for it yet. */
const endOf = (ends: Ends, key: string) => {
  const found = ends.get(key)
  if (found !== undefined) return found
  const end = Deferred.makeUnsafe<Outcome>()
  ends.set(key, end)
  return end
}

/** Whether a wake-up's run is still wanted: the row is there and names that run. */
const wantedAt =
  (at: number) =>
  (row: Row | undefined): row is Row =>
    row !== undefined && row.next_run === at

/** Holds a run while its plugin is not loaded, is off or is in a swap. */
const hold = (
  support: Context.Service.Shape<typeof Support>,
  plugin: string,
  name: string,
) =>
  Effect.gen(function* () {
    if (support.active(plugin)) return
    yield* Logger.event(
      "timer.held",
      "A timer came due for a plugin that is not loaded",
      { plugin, timer: name },
    )
    yield* support.whenActive(plugin)
  })

/**
 * The handler of a wake-up. It reads the row, waits while the plugin is not loaded, runs the turn and waits for its end,
 * reads the row again and only then stores the next run.
 */
const timerLayer = (ends: Ends) =>
  Timer.toLayer(
    Effect.gen(function* () {
      const support = yield* Support
      const sql = yield* SqlClient.SqlClient
      const storage = yield* MessageStorage.MessageStorage
      const client = yield* Timer.client
      const runs = yield* TimerRuns.client
      const scope = yield* Effect.scope
      return Timer.of({
        fire: ({ payload }) => {
          const { plugin, name, at } = payload
          const key = turnKey(plugin, name, at)
          return Effect.gen(function* () {
            // The end is asked for before any wait, so a run that ends during the hold is not missed.
            const end = endOf(ends, key)
            const wanted = wantedAt(at)
            const row = yield* read(plugin, name)
            if (!wanted(row)) return
            // A plugin that is not loaded, is off or is in a swap holds the run inside this request.
            let current = row
            if (!support.active(plugin)) {
              yield* hold(support, plugin, name)
              const again = yield* read(plugin, name)
              if (!wanted(again)) return
              current = again
            }
            // The run waits its place among the timer's runs. Its end comes from the reply or, when the reply
            // cannot be saved, from the handler in this process. The call is left to finish, since interrupting it would
            // interrupt the request.
            yield* runs(entityId(plugin, name))
              .run(
                new Queued({
                  key,
                  plugin,
                  name,
                  thread: current.thread,
                  prompt: current.prompt,
                  label: current.label,
                  ...(current.mention === null
                    ? {}
                    : { mention: current.mention }),
                  scheduledAt: at,
                }),
              )
              .pipe(
                Effect.orDie,
                Effect.exit,
                Effect.flatMap((exit) => Deferred.done(end, exit)),
                Effect.forkIn(scope),
              )
            // A run that dies is logged and not run again, and the chain goes on, so one bad run never ends a recurring
            // timer.
            yield* Deferred.await(end).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logError("A timer's run failed", cause).pipe(
                      Effect.annotateLogs({ plugin, timer: name }),
                    ),
              ),
            )
            // A cancel or a replace during the run stays in force.
            const after = yield* read(plugin, name)
            if (!wanted(after)) return
            if (after.cron === null) {
              yield* sql`DELETE FROM timers WHERE plugin = ${plugin} AND name = ${name} AND next_run = ${at}`
              return
            }
            // The next run is the first time after the turn ended, so missed times never fire in a burst.
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
          }).pipe(
            Effect.ensuring(Effect.sync(() => ends.delete(key))),
            Effect.orDie,
          )
        },
      })
    }),
    // A defect fails that one request, and the entity carries on.
    { disableFatalDefects: true },
  )

/**
 * The handler of a timer's runs, which runs each as its turn and waits for its end before it takes the next. A scheduled
 * run is checked again here, where it is admitted to its session, because it may have waited behind other runs: a
 * run whose timer was cancelled or replaced since does not start, and one whose plugin is not loaded is held. A run
 * already admitted, which a restart delivers again, goes on. A queued run is never dropped.
 */
const runsLayer = (ends: Ends) =>
  TimerRuns.toLayer(
    Effect.gen(function* () {
      const support = yield* Support
      const sql = yield* SqlClient.SqlClient
      const storage = yield* MessageStorage.MessageStorage
      const sharding = yield* Sharding.Sharding
      /** Whether the run's turn reached its session: the session has its request, or the turn has a row. */
      const admitted = (run: Queued) =>
        Effect.gen(function* () {
          const id = EntityId.make(run.thread)
          const request = yield* storage.requestIdForPrimaryKey({
            address: EntityAddress.make({
              entityType: Session.type,
              entityId: id,
              shardId: sharding.getShardId(id, Session.getShardGroup(id)),
            }),
            tag: "plugin",
            id: run.key,
          })
          if (Option.isSome(request)) return true
          const turn =
            yield* sql`SELECT 1 FROM turns WHERE request_key = ${run.key}`
          return turn.length > 0
        })
      const admit = (run: Queued) =>
        Effect.gen(function* () {
          const at = run.scheduledAt
          if (at === undefined || (yield* admitted(run))) {
            return yield* support.run(run)
          }
          const wanted = wantedAt(at)
          if (!wanted(yield* read(run.plugin, run.name))) return stale
          if (!support.active(run.plugin)) {
            yield* hold(support, run.plugin, run.name)
            if (!wanted(yield* read(run.plugin, run.name))) return stale
          }
          return yield* support.run(run)
        })
      return TimerRuns.of({
        run: ({ payload }) =>
          admit(payload).pipe(
            Effect.orDie,
            Effect.onExit((exit) => {
              const at = payload.scheduledAt
              if (at === undefined) return Effect.void
              const waiting = ends.get(payload.key)
              if (waiting !== undefined) return Deferred.done(waiting, exit)
              // An interrupted run is delivered again, so it has no end to keep.
              if (Exit.hasInterrupts(exit)) return Effect.void
              // No wake-up waits yet. While the row still names this run its wake-up is not processed and will come,
              // so the end is kept for it; otherwise nothing will ask and nothing is kept.
              return read(payload.plugin, payload.name).pipe(
                Effect.flatMap((row) =>
                  wantedAt(at)(row)
                    ? Deferred.done(endOf(ends, payload.key), exit)
                    : Effect.void,
                ),
                Effect.ignore,
              )
            }),
          ),
      })
    }),
    // A defect fails that one request, and the entity carries on.
    { disableFatalDefects: true },
  )

/** What a scheduled run that is no longer wanted gives back: nothing ran. */
const stale: Outcome = { _tag: "Stopped" }

/** The handlers of the wake-ups and of the timers' runs, which share the ends of the runs this process waits for. */
export const layer = Layer.unwrap(
  Effect.sync(() => {
    const ends: Ends = new Map()
    return Layer.mergeAll(timerLayer(ends), runsLayer(ends))
  }),
)

/** The defect a `Turns.schedule` or `Turns.cancel` dies with when its change cannot be saved. */
export const unsaved = (why: string) =>
  Effect.die(new Error(Messages.timerNotSaved(why)))
