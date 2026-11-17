// A cron job as cron stores it, one entry per job in the plugin's key-value store, and the texts
// cron puts around a job's prompt.
import { Cron, DateTime, Duration, Option, Result, Schema } from "effect"
import { ChatThread } from "effect/chat"
import type { FailedReason } from "../../Session.ts"
import type { Timer } from "../../Turns.ts"

/** One job. The key is its name, which never changes. */
export const Job = Schema.Struct({
  name: Schema.String,
  /** The owner's prompt with the wrapper lines in front. */
  prompt: Schema.String,
  /** A one-shot's time, in milliseconds since the epoch. */
  at: Schema.optionalKey(Schema.Number),
  /** A recurring job's 5-field cron expression. */
  cron: Schema.optionalKey(Schema.String),
  /** The IANA timezone, present only when it was given. */
  timezone: Schema.optionalKey(Schema.String),
  /** The thread string, `discord:<channel id>`. */
  thread: Schema.String,
  enabled: Schema.Boolean,
  notify: Schema.Boolean,
  /** The id of the owner who created the job. Absent when no owner was behind the turn. */
  owner: Schema.optionalKey(Schema.String),
  /** Failed runs in a row. */
  failures: Schema.Number,
  /** Why cron paused the job, when cron did. An owner's pause leaves it absent. */
  pausedBy: Schema.optionalKey(Schema.String),
  /**
   * Made when the job is created. The job's timer is named after it, and each run carries that name, so a run's outcome
   * goes only to the job that asked for the run.
   */
  id: Schema.String,
  /** A one-shot's run by `cronRun` that is in progress, and the job's time when it started. */
  started: Schema.optionalKey(
    Schema.Struct({ turn: Schema.String, at: Schema.Number }),
  ),
})
export type Job = typeof Job.Type

/** The wrapper lines that never change, stored with the prompt. */
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

/** The user id a job's runs mention: its owner's, unless `notify` is off. */
export const mentionOf = (job: Job) => (job.notify ? job.owner : undefined)

/** The job's timezone: the one it was given, or the owner's. */
export const zoneOf = (job: Job, owner: string) => job.timezone ?? owner

/** The thread the job was created in or moved to, where its runs go and cron's own lines go. */
export const threadOf = (job: Job) =>
  Option.getOrThrow(ChatThread.fromString(job.thread))

/**
 * The name of the job's timer, which every run of the job is queued for, so the runs go one at a time.
 */
export const timerName = (job: Job) => `${job.name}#${job.id}`

/** What `Turns.schedule` is given for an enabled job. */
export const timerOf = (job: Job, owner: string) => ({
  ...(job.cron === undefined
    ? { name: timerName(job), at: DateTime.makeUnsafe(job.at ?? 0) }
    : { name: timerName(job), cron: job.cron, timezone: zoneOf(job, owner) }),
  thread: threadOf(job),
  prompt: job.prompt,
  label: job.name,
  mention: mentionOf(job),
})

/** Whether the core's timer matches the job record in everything `Turns.schedule` was given. */
export const matches = (timer: Timer, job: Job, owner: string) =>
  ChatThread.toString(timer.thread) === job.thread &&
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

/** A schedule the tools were given, checked. */
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
    // A time with no offset is read in the job's timezone.
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
