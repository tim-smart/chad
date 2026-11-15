import { appendFileSync } from "node:fs"
import { Effect, Layer, Logger, LogLevel, References } from "effect"
import { type EventName, levelOf } from "../Events.ts"

/**
 * The file sink. A line written before the file is opened waits, because until the daemon may write the volume another
 * daemon may be the one that owns the file. `open` then writes the waiting lines, in the order stdout has them.
 */
export interface FileSink {
  readonly write: (line: string) => void
  readonly open: (path: string) => void
}

export const makeFileSink = (): FileSink => {
  let path: string | undefined
  let waiting: Array<string> = []
  const append = (lines: ReadonlyArray<string>) => {
    if (path === undefined || lines.length === 0) return
    try {
      appendFileSync(path, lines.map((line) => line + "\n").join(""))
    } catch {
      // A write that fails is dropped, and stdout still has the line.
    }
  }
  return {
    write: (line) => {
      if (path === undefined) waiting.push(line)
      else append([line])
    },
    open: (file) => {
      path = file
      append(waiting)
      waiting = []
    },
  }
}

/**
 * chad's one logger, with its two sinks. stdout gets effect's logfmt line and the file gets effect's JSON line, and
 * `level`, which is `CHAD_LOG_LEVEL`, filters both.
 */
export const layer = (options: {
  readonly level: LogLevel.LogLevel
  readonly file: FileSink
  readonly stdout?: (line: string) => void
}) => {
  const stdout =
    options.stdout ?? ((line: string) => void process.stdout.write(line + "\n"))
  const logger = Logger.make<unknown, void>((entry) => {
    if (LogLevel.isLessThan(entry.logLevel, options.level)) return
    stdout(Logger.formatLogFmt.log(entry))
    options.file.write(Logger.formatJson.log(entry))
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
 * the event's, and `reason` picks it for the one event whose level depends on its reason.
 */
export const event = (
  name: EventName,
  message: string,
  fields: Readonly<Record<string, unknown>> = {},
) =>
  Effect.logWithLevel(
    levelOf(
      name,
      typeof fields["reason"] === "string" ? fields["reason"] : undefined,
    ),
  )(message).pipe(Effect.annotateLogs({ event: name, ...fields }))
