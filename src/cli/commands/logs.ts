import {
  Console,
  Effect,
  FileSystem,
  LogLevel,
  Option,
  type PlatformError,
} from "effect"
import { Command, Flag } from "effect/cli"
import { logLevelNamed } from "../../Events.ts"
import * as Messages from "../../Messages.ts"
import * as Paths from "../../Paths.ts"
import * as Errno from "../../Errno.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Flags from "../Flags.ts"

/** The entries `chad logs` prints when no filter is given (FAIL-41). */
const last = 200

/** How often `-f` looks for new lines. */
const pollMillis = 250

/** One stored entry: effect's JSON line, and the line itself for `--json`. */
interface Entry {
  readonly line: string
  readonly timestamp: string
  readonly level: string
  readonly message: string
  readonly cause?: string
  readonly annotations: Readonly<Record<string, unknown>>
}

const parse = (line: string): Entry | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== "object" || value === null) return undefined
    const entry = value as Partial<Omit<Entry, "line">>
    return {
      line,
      timestamp: String(entry.timestamp ?? ""),
      level: String(entry.level ?? ""),
      message: String(entry.message ?? ""),
      ...(entry.cause === undefined ? {} : { cause: String(entry.cause) }),
      annotations:
        typeof entry.annotations === "object" && entry.annotations !== null
          ? entry.annotations
          : {},
    }
  } catch {
    return undefined
  }
}

/** effect's level of an entry, from the upper-case name the JSON line has. */
const levelOf = (entry: Entry): LogLevel.LogLevel =>
  logLevelNamed(entry.level) ?? "Info"

/**
 * A `--since` value: a duration such as `15m` or `2h`, or an ISO 8601 time. An ISO time with no offset is UTC
 * (FAIL-196, FAIL-197).
 */
export const since = (value: string, now: number): number | undefined => {
  const duration = /^(\d+)(s|m|h|d)$/.exec(value)
  if (duration !== null) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      duration[2] as "s" | "m" | "h" | "d"
    ]
    return now - Number(duration[1]) * unit
  }
  const iso =
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value,
    )
  if (iso === null) return undefined
  const at = Date.parse(`${iso[1]}T${iso[2] ?? "00:00"}${iso[3] ?? "Z"}`)
  return Number.isNaN(at) ? undefined : at
}

/** A value as the line for a person writes it: as it is, or as a JSON string when it has a space, a quote or an =. */
const value = (raw: unknown) => {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw)
  return /[\s"=]/.test(text) || text === "" ? JSON.stringify(text) : text
}

/** The line for a person: the time in UTC, the level, the event, the message, and the other annotations. */
export const readable = (entry: Entry) => {
  const at = new Date(entry.timestamp)
  const time = Number.isNaN(at.getTime()) ? entry.timestamp : at.toISOString()
  const { event, ...rest } = entry.annotations
  return [
    time,
    entry.level.padEnd(5),
    ...(event === undefined ? [] : [String(event)]),
    value(entry.message),
    ...Object.entries(rest).map(([key, raw]) => `${key}=${value(raw)}`),
    ...(entry.cause === undefined ? [] : [`cause=${value(entry.cause)}`]),
  ].join(" ")
}

interface Filters {
  readonly turn: Option.Option<string>
  readonly session: Option.Option<string>
  readonly plugin: Option.Option<string>
  readonly event: Option.Option<string>
  readonly level: Option.Option<LogLevel.LogLevel>
  readonly since: Option.Option<number>
}

/** Whether any of the six filters is given (FAIL-41). */
const filtered = (filters: Filters) =>
  Object.values(filters).some((filter) => Option.isSome(filter))

/** Whether an entry passes every filter given (FAIL-194). */
const matches = (filters: Filters) => (entry: Entry) => {
  const key = (name: "turn" | "session" | "plugin") =>
    Option.match(filters[name], {
      onNone: () => true,
      onSome: (wanted) => entry.annotations[name] === wanted,
    })
  return (
    key("turn") &&
    key("session") &&
    key("plugin") &&
    Option.match(filters.event, {
      onNone: () => true,
      onSome: (prefix) =>
        String(entry.annotations["event"] ?? "").startsWith(prefix),
    }) &&
    Option.match(filters.level, {
      onNone: () => true,
      onSome: (minimum) => !LogLevel.isLessThan(levelOf(entry), minimum),
    }) &&
    Option.match(filters.since, {
      onNone: () => true,
      onSome: (at) => Date.parse(entry.timestamp) >= at,
    })
  )
}

/** A file that is not there, which for a log file is one that was never written or rotated yet. */
const isNotFound = (error: PlatformError.PlatformError) =>
  error.reason._tag === "NotFound"

/** A log file that cannot be read ends the command. */
const unreadable = (path: string) => (error: PlatformError.PlatformError) =>
  new Failure({
    code: ExitCode.failed,
    message: Messages.unreadable("logs", path, Errno.code(error)),
  })

/** The text of a file, or nothing when it is not there. */
const readText = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(path).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed("")),
      Effect.mapError(unreadable(path)),
    )
  })

const lines = (text: string) => text.split("\n").filter((line) => line !== "")

/** `chad logs`: the daemon's log, read from the volume in the CLI's own process (FAIL-38). */
export const logs = Command.make(
  "logs",
  {
    turn: Flag.String("turn").pipe(
      Flag.withDescription("Only the entries of this turn"),
      Flag.optional,
    ),
    session: Flag.String("session").pipe(
      Flag.withDescription("Only the entries of this session"),
      Flag.optional,
    ),
    plugin: Flag.String("plugin").pipe(
      Flag.withDescription("Only the entries of this plugin"),
      Flag.optional,
    ),
    event: Flag.String("event").pipe(
      Flag.withDescription("Only the events whose name starts with this"),
      Flag.optional,
    ),
    level: Flag.String("level").pipe(
      Flag.withDescription("Only the entries at this level and above"),
      Flag.filterMap(
        (name) => Option.fromNullishOr(logLevelNamed(name)),
        Messages.logsLevel,
      ),
      Flag.optional,
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription(
        "Only the entries since this time, as 15m, 2h or an ISO 8601 time",
      ),
      Flag.filterMap(
        (text) => Option.fromNullishOr(since(text, Date.now())),
        Messages.logsSince,
      ),
      Flag.optional,
    ),
    follow: Flags.boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Keep printing new entries as they are written"),
    ),
    json: Flags.boolean("json").pipe(
      Flag.withDescription("Print the stored JSON lines"),
    ),
  },
  Effect.fn("logs")(function* ({ follow, json, ...filters }) {
    const environment = yield* Environment
    const pass = matches(filters)
    const print = (entries: ReadonlyArray<Entry>) =>
      entries.length === 0
        ? Effect.void
        : Console.log(
            entries
              .map((entry) => (json ? entry.line : readable(entry)))
              .join("\n"),
          )
    const parsed = (text: ReadonlyArray<string>) =>
      text.flatMap((line) => {
        const entry = parse(line)
        return entry !== undefined && pass(entry) ? [entry] : []
      })

    const files = Paths.logFiles(environment.data)
    if (!follow) {
      const texts = yield* Effect.forEach(files, readText)
      const found = parsed(texts.flatMap(lines))
      // Nothing that matches is no failure (FAIL-200).
      return yield* print(filtered(filters) ? found : found.slice(-last))
    }
    return yield* followed(
      files,
      (text) => {
        const found = parsed(text)
        return print(found)
      },
      filtered(filters) ? Infinity : last,
    )
  }),
).pipe(Command.withDescription("Print the daemon's log"))

/**
 * `-f`: what is there, and then each line as it is written. A rotation renames the file, so the open file is read to
 * its end before `chad.log` is opened again, and no line is lost (FAIL-199).
 */
const followed = Effect.fnUntraced(function* (
  files: ReadonlyArray<string>,
  print: (lines: ReadonlyArray<string>) => Effect.Effect<void>,
  start: number,
) {
  const fs = yield* FileSystem.FileSystem
  const path = files[files.length - 1]!
  const decoder = new TextDecoder()
  let rest = ""
  // The rotated files and what `chad.log` holds now are printed together, the last `start` of them.
  let held: ReadonlyArray<string> | undefined = (yield* Effect.forEach(
    files.slice(0, -1),
    readText,
  )).flatMap(lines)
  const emit = (ready: ReadonlyArray<string>) => {
    const out = held === undefined ? ready : [...held, ...ready].slice(-start)
    held = undefined
    return print(out)
  }
  const inode = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.ino),
      Effect.catchIf(isNotFound, () => Effect.succeedNone),
      Effect.mapError(unreadable(file)),
    )
  // Reads one file from the start until the path names another file.
  const one = Effect.gen(function* () {
    const file = yield* fs.open(path).pipe(Effect.mapError(unreadable(path)))
    const own = (yield* file.stat.pipe(Effect.mapError(unreadable(path)))).ino
    for (;;) {
      // What the file holds now. Checking the path first means that a rotation found below leaves nothing unread.
      const current = yield* inode(path)
      for (;;) {
        const chunk = yield* file
          .readAlloc(64 * 1024)
          .pipe(Effect.mapError(unreadable(path)))
        if (Option.isNone(chunk) || chunk.value.length === 0) break
        rest += decoder.decode(chunk.value, { stream: true })
      }
      const complete = rest.lastIndexOf("\n")
      yield* emit(complete === -1 ? [] : lines(rest.slice(0, complete)))
      rest = rest.slice(complete + 1)
      const same =
        Option.isSome(current) &&
        Option.isSome(own) &&
        current.value === own.value
      if (!same) return
      yield* Effect.sleep(pollMillis)
    }
  }).pipe(Effect.scoped)
  for (;;) {
    const there = yield* fs.exists(path).pipe(Effect.mapError(unreadable(path)))
    if (there) yield* one
    else {
      yield* emit([])
      yield* Effect.sleep(pollMillis)
    }
  }
})
