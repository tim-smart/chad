// The bundled plugin `cron` (13-timers-and-cron.md, CRON-48 to CRON-138). It uses only the plugin API (CRON-1): jobs
// live in the plugin's key-value store and each enabled job has one timer in the core. Its source is the example the
// self-edit skill points at, as `repo/examples/cron/`.
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Chat, ChatThread } from "effect/chat"
import { KeyValueStore } from "effect/persistence"
import * as Plugin from "../../Plugin.ts"
import {
  CurrentSession,
  type Outcome,
  type Turn,
  type TurnEnded,
} from "../../Session.ts"
import { Turns } from "../../Turns.ts"
import * as Jobs from "./Jobs.ts"

/** Failures in a row that pause a job (CRON-74). */
const limit = 3

/** The jobs, the lock and the calls every part of cron shares. */
class Cron extends Context.Service<
  Cron,
  {
    /** The plugin's name, which a turn's `origin.plugin` carries. */
    readonly name: string
    /** The one lock of the tools, the reconcile and the `afterTurn` hook (CRON-132). */
    readonly locked: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>
    readonly get: (name: string) => Effect.Effect<Jobs.Job | undefined>
    readonly all: Effect.Effect<ReadonlyArray<Jobs.Job>>
    readonly set: (job: Jobs.Job) => Effect.Effect<void>
    readonly remove: (name: string) => Effect.Effect<void>
    /** The owner's timezone, which a job without one of its own follows (CRON-51, CRON-115). */
    readonly zone: string
    /** Schedules the job's timer, then writes the record (CRON-129). */
    readonly enable: (job: Jobs.Job) => Effect.Effect<void>
    /** Writes the record, then cancels the job's timer (CRON-130). */
    readonly disable: (job: Jobs.Job) => Effect.Effect<void>
    /** Deletes the record, then cancels the job's timer (CRON-65, CRON-130). */
    readonly delete: (job: Jobs.Job) => Effect.Effect<void>
  }
>()("chad/plugins/cron/Cron") {
  static readonly layer = Layer.effect(
    Cron,
    Effect.gen(function* () {
      const { name, store } = yield* Plugin.PluginContext
      const turns = yield* Turns
      const zone = DateTime.zoneToString(yield* DateTime.CurrentTimeZone)
      const jobs = KeyValueStore.toSchemaStore(store, Jobs.Job)
      const lock = yield* Semaphore.make(1)
      const get = (key: string) =>
        jobs.get(key).pipe(Effect.map(Option.getOrUndefined), Effect.orDie)
      const set = (job: Jobs.Job) => jobs.set(job.name, job).pipe(Effect.orDie)
      const remove = (key: string) => jobs.remove(key).pipe(Effect.orDie)
      return Cron.of({
        name,
        locked: (effect) => Semaphore.withPermit(lock, effect),
        get,
        all: jobs.keys.pipe(
          Effect.orDie,
          Effect.flatMap((keys) => Effect.forEach(keys, get)),
          Effect.map((found) =>
            found
              .filter((job) => job !== undefined)
              .sort((a, b) => a.name.localeCompare(b.name)),
          ),
        ),
        set,
        remove,
        zone,
        enable: (job) =>
          Effect.andThen(turns.schedule(Jobs.timerOf(job, zone)), set(job)),
        disable: (job) =>
          Effect.andThen(set(job), turns.cancel(Jobs.timerName(job))),
        delete: (job) =>
          Effect.andThen(remove(job.name), turns.cancel(Jobs.timerName(job))),
      })
    }),
  )
}

/** The fields a schedule takes in `cronCreate` and `cronUpdate` (CRON-61, CRON-140). */
const scheduleFields = {
  at: Schema.optionalKey(Schema.String).annotate({
    description:
      "A one-shot's time, ISO 8601. Without an offset it is read in the job's timezone.",
  }),
  in: Schema.optionalKey(Schema.String).annotate({
    description:
      'A one-shot\'s delay from now, such as "20 minutes" or "2 hours".',
  }),
  cron: Schema.optionalKey(Schema.String).annotate({
    description:
      "A recurring job's 5-field cron expression: minute hour day-of-month month day-of-week.",
  }),
  timezone: Schema.optionalKey(Schema.String).annotate({
    description:
      "The IANA timezone the schedule is read in. Defaults to the owner's.",
  }),
  notify: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Whether the job's answer pings the owner in a server thread. On by default.",
  }),
}

/** One job as `cronList` returns it (CRON-118, CRON-137, CRON-141). */
const Listed = Schema.Struct({
  name: Schema.String,
  prompt: Schema.String,
  at: Schema.optionalKey(Schema.String),
  cron: Schema.optionalKey(Schema.String),
  timezone: Schema.String,
  timezoneGiven: Schema.Boolean,
  thread: Schema.String,
  enabled: Schema.Boolean,
  notify: Schema.Boolean,
  failures: Schema.Number,
  pausedBy: Schema.optionalKey(Schema.String),
  nextRun: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
})

const name = Schema.String.annotate({ description: "The job's name." })

const tools = Toolkit.make(
  Tool.make("cronCreate", {
    description:
      "Create a scheduled job that runs a prompt in this thread's session and posts the answer here. Give exactly one of at, in and cron. The name is unique across all jobs and cannot be changed.",
    parameters: Schema.Struct({
      name,
      prompt: Schema.String.annotate({
        description:
          "What to do on each run. Nobody is there to answer questions during a run.",
      }),
      ...scheduleFields,
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
  Tool.make("cronList", {
    description:
      "List every scheduled job, with its next run and whether cron paused it.",
    success: Schema.Array(Listed),
    dependencies: [CurrentSession],
  }),
  Tool.make("cronUpdate", {
    description:
      "Change a job from the next run on. Fields left out keep their value. The job moves to the thread this is called from. enabled: false pauses it, enabled: true resumes it and resets its failure count.",
    parameters: Schema.Struct({
      name,
      prompt: Schema.optionalKey(Schema.String),
      ...scheduleFields,
      enabled: Schema.optionalKey(Schema.Boolean),
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
  Tool.make("cronRemove", {
    description: "Delete a job. A run already in progress finishes.",
    parameters: Schema.Struct({ name }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
  Tool.make("cronRun", {
    description:
      "Run a job now, paused or not, without changing its schedule. Returns once the run is queued. A run in this thread starts after the current turn ends.",
    parameters: Schema.Struct({ name }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentSession],
  }),
)

/** The id of the owner behind the calling turn (CRON-112, CRON-113). */
const ownerOf = (cron: Cron["Service"], turn: Option.Option<Turn>) =>
  Effect.gen(function* () {
    if (Option.isNone(turn)) return undefined
    const origin = turn.value.origin
    if (origin._tag === "Message") return origin.message.author.id
    return (yield* jobOf(cron, turn.value))?.owner
  })

const unknown = (job: string) => `name: no job is named "${job}".`

/** A timezone the tools were given, checked (CRON-119). */
const checkZone = (zone: string | undefined) =>
  zone === undefined || Option.isSome(DateTime.zoneMakeNamed(zone))
    ? Effect.void
    : Effect.fail(`timezone: "${zone}" is not an IANA timezone.`)

const handlers = tools.toLayer(
  Effect.gen(function* () {
    const cron = yield* Cron
    const turns = yield* Turns
    const next = (job: Jobs.Job, schedule: Jobs.Schedule) =>
      Effect.map(DateTime.now, (now) =>
        Jobs.show(
          Jobs.nextOf(schedule, Jobs.zoneOf(job, cron.zone), now),
          Jobs.zoneOf(job, cron.zone),
        ),
      )
    return tools.of({
      cronCreate: (input) =>
        cron.locked(
          Effect.gen(function* () {
            const { session, turn } = yield* CurrentSession
            yield* checkZone(input.timezone)
            if (input.name.trim() === "") {
              return yield* Effect.fail("name: a job needs a name.")
            }
            if ((yield* cron.get(input.name)) !== undefined) {
              return yield* Effect.fail(
                `name: a job named "${input.name}" already exists.`,
              )
            }
            const zone = input.timezone ?? cron.zone
            const now = yield* DateTime.now
            const schedule = Jobs.parseSchedule(input, zone, now)
            if (Result.isFailure(schedule)) {
              return yield* Effect.fail(schedule.failure)
            }
            const owner = yield* ownerOf(cron, yield* turn)
            const job: Jobs.Job = {
              name: input.name,
              prompt: Jobs.wrap(input.name, input.prompt),
              ...schedule.success,
              ...(input.timezone === undefined
                ? {}
                : { timezone: input.timezone }),
              thread: ChatThread.toString(session.thread),
              enabled: true,
              notify: input.notify ?? true,
              ...(owner === undefined ? {} : { owner }),
              failures: 0,
              id: crypto.randomUUID(),
            }
            yield* cron.enable(job)
            return `Created "${job.name}". Next run: ${yield* next(job, schedule.success)}.`
          }),
        ),
      cronList: () =>
        cron.locked(
          Effect.gen(function* () {
            const jobs = yield* cron.all
            const timers = new Map(
              (yield* turns.scheduled()).map((timer) => [timer.name, timer]),
            )
            const now = DateTime.toEpochMillis(yield* DateTime.now)
            return jobs.map((job) => {
              const zone = Jobs.zoneOf(job, cron.zone)
              const timer = timers.get(Jobs.timerName(job))
              // An enabled one-shot past its time with no timer fired, and its outcome never reached cron (CRON-137).
              const fired =
                job.enabled &&
                job.at !== undefined &&
                job.at <= now &&
                timer === undefined
              return {
                name: job.name,
                prompt: Jobs.unwrap(job),
                ...(job.at === undefined
                  ? {}
                  : { at: Jobs.show(DateTime.makeUnsafe(job.at), zone) }),
                ...(job.cron === undefined ? {} : { cron: job.cron }),
                timezone: zone,
                timezoneGiven: job.timezone !== undefined,
                thread: job.thread,
                enabled: job.enabled,
                notify: job.notify,
                failures: job.failures,
                ...(job.pausedBy === undefined
                  ? {}
                  : { pausedBy: job.pausedBy }),
                ...(job.enabled && timer !== undefined
                  ? { nextRun: Jobs.show(timer.nextRun, zone) }
                  : {}),
                ...(fired ? { note: "fired, outcome not recorded" } : {}),
              }
            })
          }),
        ),
      cronUpdate: (input) =>
        cron.locked(
          Effect.gen(function* () {
            const { session } = yield* CurrentSession
            const job = yield* cron.get(input.name)
            if (job === undefined)
              return yield* Effect.fail(unknown(input.name))
            yield* checkZone(input.timezone)
            const timezone = input.timezone ?? job.timezone
            const given =
              input.at !== undefined ||
              input.in !== undefined ||
              input.cron !== undefined
            const now = yield* DateTime.now
            const schedule: Jobs.Schedule = given
              ? yield* Result.match(
                  Jobs.parseSchedule(input, timezone ?? cron.zone, now),
                  { onFailure: Effect.fail, onSuccess: Effect.succeed },
                )
              : job.cron === undefined
                ? { at: job.at ?? 0 }
                : { cron: job.cron }
            const { at: _at, cron: _cron, timezone: _zone, ...rest } = job
            const enabled = input.enabled ?? job.enabled
            let updated: Jobs.Job = {
              ...rest,
              ...schedule,
              ...(timezone === undefined ? {} : { timezone }),
              ...(input.prompt === undefined
                ? {}
                : { prompt: Jobs.wrap(job.name, input.prompt) }),
              // Called from another thread, the job moves there (CRON-64).
              thread: ChatThread.toString(session.thread),
              enabled,
              notify: input.notify ?? job.notify,
            }
            // Turning a job on starts its count again (CRON-125), and a pause set here is the owner's own.
            if (input.enabled !== undefined) {
              const { pausedBy: _pausedBy, ...kept } = updated
              updated = { ...kept, failures: input.enabled ? 0 : job.failures }
            }
            if (!enabled) {
              yield* cron.disable(updated)
              return `Updated "${job.name}". It is paused.`
            }
            yield* cron.enable(updated)
            return `Updated "${job.name}". Next run: ${yield* next(updated, schedule)}.`
          }),
        ),
      cronRemove: ({ name }) =>
        cron.locked(
          Effect.gen(function* () {
            const job = yield* cron.get(name)
            if (job === undefined) return yield* Effect.fail(unknown(name))
            yield* cron.delete(job)
            return `Removed "${name}".`
          }),
        ),
      cronRun: ({ name }) =>
        cron.locked(
          Effect.gen(function* () {
            const job = yield* cron.get(name)
            if (job === undefined) return yield* Effect.fail(unknown(name))
            // The schedule is left alone, so a paused job runs too (CRON-66, CRON-120). The run is queued for the job's
            // timer, behind the job's runs that are queued or in progress wherever they are, and runs in the job's
            // thread (CRON-72, CRON-148). The one request is all that is saved.
            yield* turns.queue({
              thread: Jobs.threadOf(job),
              prompt: job.prompt,
              label: job.name,
              mention: Jobs.mentionOf(job),
              timer: Jobs.timerName(job),
            })
            return "queued"
          }),
        ),
    })
  }),
)

/** The two static lines on how to schedule (CRON-68, CRON-143). */
const chunk =
  "Scheduled jobs: cronCreate runs a prompt later in this thread, once (at a time or in a delay) or on a 5-field cron expression, and cronList, cronUpdate, cronRemove and cronRun see and manage the jobs.\n" +
  "A job's prompt runs with nobody there to answer questions, so write it to be done alone and to say what to post. A run may answer [SILENT] to post nothing."

/**
 * The job a turn of cron's is a run of: the job its label names, when the turn carries that job's timer name. A run
 * of an earlier job of the same name carries another one, and has no job (CRON-111, CRON-149).
 */
const jobOf = (cron: Cron["Service"], turn: Turn) =>
  Effect.gen(function* () {
    const origin = turn.origin
    if (origin._tag !== "Plugin" || origin.plugin !== cron.name) {
      return undefined
    }
    const job = yield* cron.get(origin.label)
    const timer = origin.timer?.name ?? origin.queuedFor
    return job !== undefined && Jobs.timerName(job) === timer ? job : undefined
  })

/** When a scheduled run was due and how late it started (CRON-70, CRON-144). */
const due = (cron: Cron["Service"], turn: Turn) =>
  Effect.gen(function* () {
    const origin = turn.origin
    if (
      origin._tag !== "Plugin" ||
      origin.plugin !== cron.name ||
      origin.timer === undefined
    ) {
      return
    }
    const job = yield* jobOf(cron, turn)
    const zone = job === undefined ? cron.zone : Jobs.zoneOf(job, cron.zone)
    const late = Math.max(
      0,
      DateTime.toEpochMillis(turn.startedAt) -
        DateTime.toEpochMillis(origin.timer.scheduledAt),
    )
    const seconds = Math.round(late / 1000)
    return `This run of "${origin.label}" was due at ${Jobs.show(origin.timer.scheduledAt, zone)} and started ${seconds === 0 ? "on time" : `${Duration.format(Duration.seconds(seconds))} late`}.`
  })

/**
 * Records a one-shot's time when a `cronRun` run of it starts, so a change of the time during the run outlives the
 * run (CRON-67, CRON-149). A resumed turn keeps its id, and the time recorded at its first start.
 */
const mark = (cron: Cron["Service"], turn: Turn) =>
  Effect.gen(function* () {
    const job = yield* jobOf(cron, turn)
    if (
      job === undefined ||
      job.at === undefined ||
      turn.origin._tag !== "Plugin" ||
      turn.origin.timer !== undefined ||
      job.started?.turn === turn.id
    ) {
      return
    }
    yield* cron.set({ ...job, started: { turn: turn.id, at: job.at } })
  })

/**
 * What a run's outcome makes of its job: the job to keep, or none when a one-shot is done, and the pause line to post
 * (CRON-52, CRON-73 to CRON-77, CRON-89, CRON-122 to CRON-127).
 */
const afterRun = (
  job: Jobs.Job,
  outcome: Outcome,
): { readonly job?: Jobs.Job; readonly line?: string } => {
  const oneShot = job.cron === undefined
  const pause = (pausedBy: string) => ({
    job: { ...job, enabled: false, pausedBy },
  })
  if (outcome._tag === "Failed") {
    const reason = outcome.reason
    switch (reason._tag) {
      case "LoggedOut":
      case "LoginFailed":
      case "UsageLimit":
        // Not the job's failure. A one-shot is kept, paused, so it is not lost (CRON-77, CRON-126).
        return oneShot ? pause(reason._tag) : { job }
      case "ThreadGone":
      case "GaveUp":
        // Paused at once, and a one-shot is deleted (CRON-52, CRON-76, CRON-89).
        return oneShot ? {} : pause(reason._tag)
      default: {
        if (oneShot) return {}
        const failures = job.failures + 1
        if (failures < limit) return { job: { ...job, failures } }
        const text = Jobs.reasonText(reason)
        return {
          job: {
            ...job,
            failures,
            enabled: false,
            pausedBy: `${failures} failed runs in a row (${text})`,
          },
          line: `Paused \`${job.name}\` after ${failures} failed runs in a row (${text}). Resume it when the cause is fixed.`,
        }
      }
    }
  }
  // An answer or a stop is a run that happened, so a one-shot is done (CRON-52). A stop leaves the count (CRON-124).
  if (oneShot) return {}
  return { job: outcome._tag === "Answered" ? { ...job, failures: 0 } : job }
}

/** Counts a run's outcome against its job, pausing or deleting it. */
const settle = (cron: Cron["Service"], { turn, outcome }: TurnEnded) =>
  Effect.gen(function* () {
    const found = yield* jobOf(cron, turn)
    if (found === undefined || turn.origin._tag !== "Plugin") return
    const { started, ...job } = found
    const save = (next: Jobs.Job) =>
      next.enabled ? cron.set(next) : cron.disable(next)
    // A one-shot moved to a new time while this run was in progress keeps its new time (CRON-67, CRON-149).
    const timer = turn.origin.timer
    const at =
      timer !== undefined
        ? DateTime.toEpochMillis(timer.scheduledAt)
        : started?.turn === turn.id
          ? started.at
          : job.at
    if (job.cron === undefined && at !== job.at) {
      return started?.turn === turn.id ? yield* cron.set(job) : undefined
    }
    const after = afterRun(job, outcome)
    if (after.job === undefined) return yield* cron.delete(job)
    yield* save(after.job)
    if (after.line !== undefined) {
      const chat = yield* Chat.Chat
      // The line reports an event, so every such pause posts it (CRON-74, FAIL-72).
      yield* chat.post(Jobs.threadOf(job), { markdown: after.line })
    }
  })

/**
 * Makes the core's timers match the job records, which are the truth (CRON-78, CRON-79, CRON-128). It runs once each
 * activation, in a background fiber, so its `Turns` calls wait for the activation and not the build (CRON-131).
 */
const reconcile = (cron: Cron["Service"]) =>
  Effect.gen(function* () {
    const turns = yield* Turns
    const jobs = new Map((yield* cron.all).map((job) => [job.name, job]))
    const timers = yield* turns.scheduled()
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    const wanted = new Set(
      [...jobs.values()]
        .filter((job) => job.enabled)
        .map((job) => Jobs.timerName(job)),
    )
    for (const timer of timers) {
      if (!wanted.has(timer.name)) yield* turns.cancel(timer.name)
    }
    const scheduled = new Map(timers.map((timer) => [timer.name, timer]))
    for (const job of jobs.values()) {
      if (!job.enabled) continue
      const timer = scheduled.get(Jobs.timerName(job))
      if (timer !== undefined && Jobs.matches(timer, job, cron.zone)) continue
      // A one-shot past its time with no timer fired, and cron leaves it for its outcome (CRON-79, CRON-138).
      if (timer === undefined && job.at !== undefined && job.at <= now) continue
      yield* turns.schedule(Jobs.timerOf(job, cron.zone))
    }
  })

export default Plugin.make(
  Layer.mergeAll(
    Plugin.toolkit(tools).pipe(Layer.provide(handlers)),
    Plugin.prompt(() => Effect.succeed(chunk)),
    Plugin.beforeTurn((turn) =>
      Effect.flatMap(Cron, (cron) =>
        Effect.andThen(cron.locked(mark(cron, turn)), due(cron, turn)),
      ),
    ),
    Plugin.afterTurn((ended) =>
      Effect.flatMap(Cron, (cron) => cron.locked(settle(cron, ended))),
    ),
    Plugin.background(
      Effect.flatMap(Cron, (cron) => cron.locked(reconcile(cron))),
    ),
  ).pipe(Layer.provide(Cron.layer)),
)
