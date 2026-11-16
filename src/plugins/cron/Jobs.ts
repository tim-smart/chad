// A cron job as cron stores it, one entry per job in the plugin's key-value store (CRON-48, CRON-53), and the texts
// cron puts around a job's prompt (CRON-69, CRON-121).
import { Cron, DateTime, Duration, Option, Result, Schema } from "effect"
import { ChatThread } from "effect/chat"
import type { FailedReason } from "../../Session.ts"
import type { Timer } from "../../Turns.ts"

/**
 * The runs of a job that are queued by `cronRun` or in progress. They are all in one thread, whose session runs them one
 * at a time, and the job's new runs go there too until they have ended (CRON-72, CRON-148).
 */
export const Runs = Schema.Struct({
  thread: Schema.String,
  /** Runs `cronRun` queued that have not started. */
  queued: Schema.Number,
  /** The id of the turn of the run in progress. */
  turn: Schema.optionalKey(Schema.String),
  /** A one-shot's time when the run in progress started (CRON-67). */
  at: Schema.optionalKey(Schema.Number),
})
export type Runs = typeof Runs.Type

/** One job. The key is its name, which never changes (CRON-109, CRON-110). */
export const Job = Schema.Struct({
  name: Schema.String,
  /** The owner's prompt with the wrapper lines in front (CRON-69). */
  prompt: Schema.String,
  /** A one-shot's time, in milliseconds since the epoch. */
  at: Schema.optionalKey(Schema.Number),
  /** A recurring job's 5-field cron expression. */
  cron: Schema.optionalKey(Schema.String),
  /** The IANA timezone, present only when it was given (CRON-114). */
  timezone: Schema.optionalKey(Schema.String),
  /** The thread string, `discord:<channel id>` (CRON-95). */
  thread: Schema.String,
  enabled: Schema.Boolean,
  notify: Schema.Boolean,
  /** The id of the owner who created the job. Absent when no owner was behind the turn (CRON-113). */
  owner: Schema.optionalKey(Schema.String),
  /** Failed runs in a row (CRON-122). */
  failures: Schema.Number,
  /** Why cron paused the job, when cron did. An owner's pause leaves it absent. */
  pausedBy: Schema.optionalKey(Schema.String),
  /** When the job was created, in milliseconds since the epoch. A run that started earlier is another job's (CRON-149). */
  created: Schema.Number,
  runs: Schema.optionalKey(Runs),
})
export type Job = typeof Job.Type

/** The wrapper lines that never change, stored with the prompt (CRON-69, CRON-121, CRON-142). */
export const wrap = (name: string, prompt: string) =>
  `This is a scheduled run of the cron job "${name}", and nobody is there to answer questions.\n` +
  `Do the task below on your own and answer with what the owner should read. Answer exactly [SILENT] when there is nothing worth posting.\n\n` +
  prompt

/** The owner's prompt without the wrapper. */
export const unwrap = (job: Job) => {
  const wrapper = wrap(job.name, "")
  return job.prompt.startsWith(wrapper)
    ? job.prompt.slice(wrapper.length)
    : job.prompt
}

/** The user id a job's runs mention: its owner's, unless `notify` is off (CRON-71). */
export const mentionOf = (job: Job) => (job.notify ? job.owner : undefined)

/** The job's timezone: the one it was given, or the owner's (CRON-115, CRON-116). */
export const zoneOf = (job: Job, owner: string) => job.timezone ?? owner

export const parse = (thread: string) =>
  Option.getOrThrow(ChatThread.fromString(thread))

/** The thread the job was created in or moved to, which cron's own lines go to. */
export const threadOf = (job: Job) => parse(job.thread)

/** The thread the job's next run goes to: that of its runs still queued or in progress, or its own (CRON-148). */
export const runsIn = (job: Job) => job.runs?.thread ?? job.thread

/** A job's runs once a run of it started in `thread`. A run `cronRun` queued is no longer waiting. */
export const started = (
  job: Job,
  thread: string,
  turn: string,
  manual: boolean,
): Runs => ({
  thread,
  queued: Math.max(0, (job.runs?.queued ?? 0) - (manual ? 1 : 0)),
  turn,
  ...(job.at === undefined ? {} : { at: job.at }),
})

/**
 * A job's runs once a run of it ended, or none when nothing is left. A queued run that ended without starting, as one
 * whose thread is gone does, is no longer waiting either.
 */
export const ended = (
  runs: Runs | undefined,
  turn: string,
  manual: boolean,
): Runs | undefined => {
  if (runs === undefined) return undefined
  const { turn: current, at: _at, ...rest } = runs
  const left: Runs =
    current === turn
      ? rest
      : manual
        ? { ...runs, queued: Math.max(0, runs.queued - 1) }
        : runs
  return left.queued === 0 && left.turn === undefined ? undefined : left
}

/** What `Turns.schedule` is given for an enabled job. */
export const timerOf = (job: Job, owner: string) => ({
  ...(job.cron === undefined
    ? { name: job.name, at: DateTime.makeUnsafe(job.at ?? 0) }
    : { name: job.name, cron: job.cron, timezone: zoneOf(job, owner) }),
  thread: parse(runsIn(job)),
  prompt: job.prompt,
  label: job.name,
  mention: mentionOf(job),
})

/** Whether the core's timer matches the job record in everything `Turns.schedule` was given (CRON-128). */
export const matches = (timer: Timer, job: Job, owner: string) =>
  ChatThread.toString(timer.thread) === runsIn(job) &&
  timer.prompt === job.prompt &&
  timer.label === job.name &&
  timer.mention === mentionOf(job) &&
  ("at" in timer.schedule
    ? job.cron === undefined &&
      DateTime.toEpochMillis(timer.schedule.at) === job.at
    : timer.schedule.cron === job.cron &&
      timer.schedule.timezone === zoneOf(job, owner))

/** A failed run's reason as the pause line names it. */
export const reasonText = (reason: FailedReason) =>
  reason._tag === "ModelError" ? `ModelError, ${reason.reason}` : reason._tag

/** A time as the tools and the due line show it, in a timezone. */
export const show = (time: DateTime.DateTime, zone: string) =>
  Option.match(DateTime.makeZoned(time, { timeZone: zone }), {
    onNone: () => DateTime.formatIso(time),
    onSome: DateTime.formatIsoZoned,
  })

/** A schedule the tools were given, checked (CRON-50, CRON-119). */
export type Schedule = { readonly at: number } | { readonly cron: string }

/** Reads the one of `at`, `in` and `cron` a tool was given, or says which field is wrong. */
export const parseSchedule = (
  given: {
    readonly at?: string | undefined
    readonly in?: string | undefined
    readonly cron?: string | undefined
  },
  zone: string,
  now: DateTime.Utc,
): Result.Result<Schedule, string> => {
  const fields = (["at", "in", "cron"] as const).filter(
    (field) => given[field] !== undefined,
  )
  if (fields.length !== 1) {
    return Result.fail("Give exactly one of at, in and cron for the schedule.")
  }
  if (given.cron !== undefined) {
    const expression = given.cron.trim()
    if (expression.split(/\s+/).length !== 5) {
      return Result.fail(
        `cron: "${given.cron}" is not a 5-field cron expression (minute hour day-of-month month day-of-week).`,
      )
    }
    const parsed = Cron.parse(expression, zone)
    return Result.isFailure(parsed)
      ? Result.fail(
          `cron: "${given.cron}" is invalid: ${parsed.failure.message}.`,
        )
      : Result.succeed({ cron: expression })
  }
  let at: number
  if (given.in !== undefined) {
    const delay = Duration.fromInput(given.in.trim() as Duration.Input)
    if (Option.isNone(delay)) {
      return Result.fail(
        `in: "${given.in}" is not a delay such as "20 minutes" or "2 hours".`,
      )
    }
    at = DateTime.toEpochMillis(now) + Duration.toMillis(delay.value)
  } else {
    const text = (given.at ?? "").trim()
    // A time with no offset is read in the job's timezone (CRON-140).
    const parsed: Option.Option<DateTime.DateTime> =
      /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
        ? DateTime.make(text)
        : DateTime.makeZoned(text, { timeZone: zone, adjustForTimeZone: true })
    if (Option.isNone(parsed)) {
      return Result.fail(`at: "${given.at}" is not an ISO 8601 time.`)
    }
    at = DateTime.toEpochMillis(parsed.value)
  }
  if (at <= DateTime.toEpochMillis(now)) {
    return Result.fail(
      `${given.in === undefined ? "at" : "in"}: ${show(DateTime.makeUnsafe(at), zone)} is in the past.`,
    )
  }
  return Result.succeed({ at })
}

/** The next run of a schedule, for a tool's result. */
export const nextOf = (schedule: Schedule, zone: string, now: DateTime.Utc) =>
  "at" in schedule
    ? DateTime.makeUnsafe(schedule.at)
    : DateTime.makeUnsafe(Cron.next(Cron.parseUnsafe(schedule.cron, zone), now))
