import { appendFileSync, renameSync, statSync } from "node:fs"
import {
  Cause,
  Console,
  Context,
  Effect,
  Layer,
  Logger,
  LogLevel,
  References,
} from "effect"
import { TaskOwner } from "clanka/AgentTools"
import { type EventName, levelOf } from "../Events.ts"
import * as Paths from "../Paths.ts"

/** The size past which `chad.log` is rotated, and how many rotated files are kept. */
export const rotation = {
  maxBytes: 10 * 1024 * 1024,
  keep: Paths.logKept,
} as const

/**
 * The file sink. A line written before the file is opened waits, because until the daemon may write the volume another
 * daemon may be the one that owns the file. `open` then writes the waiting lines, in the order stdout has them. Once
 * the file is open every line is appended as it is written, so nothing waits for a later write and no exit path
 * leaves a line behind.
 */
export interface FileSink {
  readonly write: (line: string) => void
  readonly open: (path: string) => void
}

/** The size of the file, or 0 when there is none yet. */
const sizeOf = (path: string) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export const makeFileSink = (
  options: { readonly maxBytes?: number; readonly keep?: number } = {},
): FileSink => {
  const maxBytes = options.maxBytes ?? rotation.maxBytes
  const keep = options.keep ?? rotation.keep
  let path: string | undefined
  let size = 0
  let waiting: Array<string> = []
  // chad.log.2 -> chad.log.3, chad.log.1 -> chad.log.2, chad.log -> chad.log.1. The oldest is overwritten.
  const rotate = (file: string) => {
    for (let index = keep; index >= 1; index--) {
      try {
        renameSync(
          index === 1 ? file : `${file}.${index - 1}`,
          `${file}.${index}`,
        )
      } catch {
        // A file that is not there yet has nothing to move.
      }
    }
    size = 0
  }
  // A rotation happens only between two lines, so no line is split across two files.
  const append = (lines: ReadonlyArray<string>) => {
    if (path === undefined || lines.length === 0) return
    try {
      let chunk = ""
      let bytes = 0
      for (const line of lines) {
        const text = line + "\n"
        const length = Buffer.byteLength(text)
        if (size + bytes > 0 && size + bytes + length > maxBytes) {
          if (bytes > 0) appendFileSync(path, chunk)
          chunk = ""
          bytes = 0
          rotate(path)
        }
        chunk += text
        bytes += length
      }
      if (bytes > 0) {
        appendFileSync(path, chunk)
        size += bytes
      }
    } catch {
      // A write that fails, as on a full disk, is dropped, and stdout still has the line.
    }
  }
  return {
    write: (line) => {
      if (path === undefined) waiting.push(line)
      else append([line])
    },
    open: (file) => {
      path = file
      size = sizeOf(file)
      append(waiting)
      waiting = []
    },
  }
}

/**
 * The ids a session's lines carry, one mutable object per session. chad provides it where the session's executor
 * layer is built and where its Agent is built, sets `turn` when a turn starts and clears it when the turn ends.
 */
export interface SessionLogIds {
  readonly session: string
  turn: string | undefined
  /**
   * The number of each of the session's sub-agents, by the task owner clanka runs its scripts' tool calls under.
   * The root agent's owner is never in it.
   */
  readonly subagents: Map<string, number>
}

export const CurrentLogIds = Context.Reference<SessionLogIds | undefined>(
  "chad/CurrentLogIds",
  { defaultValue: () => undefined },
)

/** The number of the sub-agent whose script a fiber runs, where chad runs the script. */
export const CurrentSubagent = Context.Reference<number | undefined>(
  "chad/CurrentSubagent",
  { defaultValue: () => undefined },
)

/** The name of the plugin chad runs something for. Nothing sets it until plugins arrive. */
export const PluginName = Context.Reference<string | undefined>(
  "chad/PluginName",
  { defaultValue: () => undefined },
)

/**
 * What the text of a fiber's lines passes through before they are formatted. The MCP layer's fibers carry one that
 * keeps the values its `${NAME}`s expanded to out of the log.
 */
export const Scrub = Context.Reference<((line: string) => string) | undefined>(
  "chad/Logger/Scrub",
  { defaultValue: () => undefined },
)

/**
 * The counts of the plugin chad runs something for, which every warning and error line it logs adds to.
 */
export const PluginCounts = Context.Reference<
  { warnings: number; errors: number; latest: string | undefined } | undefined
>("chad/PluginCounts", { defaultValue: () => undefined })

/** Adds a plugin's line to its counts, when it is a warning or an error. */
const count = (entry: Entry) => {
  const counts = entry.fiber.getRef(PluginCounts)
  if (counts === undefined || LogLevel.isLessThan(entry.logLevel, "Warn")) {
    return
  }
  if (LogLevel.isLessThan(entry.logLevel, "Error")) counts.warnings++
  else counts.errors++
  const message = Array.isArray(entry.message)
    ? entry.message[0]
    : entry.message
  counts.latest = typeof message === "string" ? message : String(message)
}

/** The console a fiber sees when nothing provided one. clanka provides a script's own console to its fibers. */
const daemonConsole = Effect.runSync(Console.consoleWith(Effect.succeed))

/**
 * Runs `effect` with the daemon's console, so its lines go to the sinks only. A sub-agent's fibers can have the
 * console of the script that started it, which would print chad's own lines into what the model reads.
 */
export const ownConsole = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Console.Console, daemonConsole)

type Entry = Logger.Options<unknown>
type Fiber = Entry["fiber"]

/** The ids of a line, from the fiber that logged it. */
const idsOf = (fiber: Fiber): Readonly<Record<string, string | number>> => {
  const cell = fiber.getRef(CurrentLogIds)
  const plugin = fiber.getRef(PluginName)
  // A tool call runs on a fiber clanka makes, which carries the task owner of the agent whose script called it.
  const owner = fiber.getRef(TaskOwner)
  const subagent =
    fiber.getRef(CurrentSubagent) ??
    (owner === undefined ? undefined : cell?.subagents.get(owner))
  return {
    ...(cell === undefined ? {} : { session: cell.session }),
    ...(cell?.turn === undefined ? {} : { turn: cell.turn }),
    ...(subagent === undefined ? {} : { subagent }),
    ...(plugin === undefined ? {} : { plugin }),
  }
}

/**
 * The entry as chad's sinks see it: the fiber's annotations with the ids added after `event`. effect's formatters read
 * the annotations from the fiber, so the fiber is wrapped. An annotation the line set itself is kept.
 */
const withIds = (
  entry: Entry,
  ids: Readonly<Record<string, string | number>>,
) => {
  if (Object.keys(ids).length === 0) return entry
  const own = entry.fiber.getRef(References.CurrentLogAnnotations)
  // A plugin's own line carries `plugin.log` unless it set an event itself.
  const annotations = {
    ...("event" in own
      ? { event: own["event"] }
      : ids["plugin"] === undefined
        ? {}
        : { event: "plugin.log" }),
    ...ids,
    ...own,
  }
  return withAnnotations(entry, annotations)
}

/** The entry with its fiber's annotations replaced. effect's formatters read them from the fiber, so it is wrapped. */
const withAnnotations = (
  entry: Entry,
  annotations: Readonly<Record<string, unknown>>,
): Entry => {
  const fiber = new Proxy(entry.fiber, {
    get: (target, key) => {
      if (key === "getRef") {
        return (reference: Context.Key<unknown, unknown>) =>
          reference === References.CurrentLogAnnotations
            ? annotations
            : target.getRef(reference as never)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { ...entry, fiber }
}

/** A value of a line's message or annotations, scrubbed. A value that is not a string stays as it is unless its text held a value. */
const scrubValue = (value: unknown, scrub: (text: string) => string) => {
  if (typeof value === "string") return scrub(value)
  if (value === null || value === undefined) return value
  let text: string
  try {
    text =
      typeof value === "object"
        ? (JSON.stringify(value) ?? String(value))
        : String(value)
  } catch {
    text = String(value)
  }
  const scrubbed = scrub(text)
  return scrubbed === text ? value : scrubbed
}

/**
 * The entry with the fiber's scrubber run over its message, its annotations' values and its cause, before a formatter
 * serializes it, so the line stays well formed and its keys stay as they are.
 */
const scrubbed = (entry: Entry): Entry => {
  const scrub = entry.fiber.getRef(Scrub)
  if (scrub === undefined) return entry
  const message = Array.isArray(entry.message)
    ? entry.message.map((part: unknown) => scrubValue(part, scrub))
    : scrubValue(entry.message, scrub)
  const pretty =
    entry.cause.reasons.length === 0 ? "" : Cause.pretty(entry.cause)
  const cause =
    scrub(pretty) === pretty ? entry.cause : Cause.fail(scrub(pretty))
  const annotations = Object.fromEntries(
    Object.entries(entry.fiber.getRef(References.CurrentLogAnnotations)).map(
      ([key, value]) => [key, scrubValue(value, scrub)],
    ),
  )
  return withAnnotations({ ...entry, message, cause }, annotations)
}

/**
 * chad's one logger, with its two sinks. stdout gets effect's logfmt line and the file gets effect's JSON
 * line, and `level`, which is `CHAD_LOG_LEVEL`, filters both. A line logged on a fiber whose console is a script's is
 * printed into the script's output by effect's default logger, as plain clanka does, and only at Info and above
 * whatever the level is. Its copy goes to the sinks, capped at Info when clanka logged it.
 */
export const layer = (options: {
  readonly level: LogLevel.LogLevel
  readonly file: FileSink
  readonly stdout?: (line: string) => void
}) => {
  const stdout =
    options.stdout ?? ((line: string) => void process.stdout.write(line + "\n"))
  const sinks = (entry: Entry) => {
    if (LogLevel.isLessThan(entry.logLevel, options.level)) return
    stdout(Logger.formatLogFmt.log(entry))
    options.file.write(Logger.formatJson.log(entry))
  }
  const logger = Logger.make<unknown, void>((raw) => {
    const entry = scrubbed(raw)
    const ids = idsOf(entry.fiber)
    if (ids["plugin"] !== undefined) count(entry)
    if (entry.fiber.getRef(Console.Console) !== daemonConsole) {
      if (!LogLevel.isLessThan(entry.logLevel, "Info")) {
        Logger.defaultLogger.log(entry)
      }
      const clanka =
        ids["plugin"] === undefined &&
        LogLevel.isGreaterThan(entry.logLevel, "Info")
      sinks(withIds(clanka ? { ...entry, logLevel: "Info" } : entry, ids))
      return
    }
    sinks(withIds(entry, ids))
  })
  // effect's own minimum is the more verbose of Info and the level, so the variable can only lower it.
  const minimum = LogLevel.isLessThan(options.level, "Info")
    ? options.level
    : "Info"
  return Layer.merge(
    Logger.layer([logger]),
    Layer.succeed(References.MinimumLogLevel, minimum),
  )
}

/**
 * One line of chad's own. It passes one message, puts everything else in annotations and sets no span. The level is
 * the event's, and `reason` picks it for the one event whose level depends on its reason. A cause is the entry's own
 * `cause`, which both sinks print in full.
 */
export const event = (
  name: EventName,
  message: string,
  fields: Readonly<Record<string, unknown>> = {},
  cause?: Cause.Cause<unknown>,
) =>
  Effect.logWithLevel(
    levelOf(
      name,
      typeof fields["reason"] === "string" ? fields["reason"] : undefined,
    ),
  )(...(cause === undefined ? [message] : [message, cause])).pipe(
    Effect.annotateLogs({ event: name, ...fields }),
  )
