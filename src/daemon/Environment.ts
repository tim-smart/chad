import type { LogLevel } from "effect"

/** The values of `CHAD_LOG_LEVEL`, each with effect's level of the same name. */
const levels: Record<string, LogLevel.LogLevel> = {
  all: "All",
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
  fatal: "Fatal",
  none: "None",
}

/**
 * What the daemon takes from the environment table of docs/spec/01-image-and-volume.md. It is read when `runDaemon`
 * starts and never at module load, so two daemons started one after another in one process can differ.
 */
export interface Environment {
  /** `CHAD_DATA`, the data directory. */
  readonly data: string
  /** `CHAD_MODEL`, the default model setting. */
  readonly model: string | undefined
  readonly openaiApiUrl: string | undefined
  readonly openaiApiKey: string | undefined
  readonly logLevel: LogLevel.LogLevel
  /** The value of `CHAD_LOG_LEVEL` when it names no level. */
  readonly unknownLogLevel: string | undefined
}

export const read = (env: NodeJS.ProcessEnv): Environment => {
  const named = env["CHAD_LOG_LEVEL"]
  const level = named === undefined ? "Info" : levels[named.toLowerCase()]
  return {
    data: env["CHAD_DATA"] ?? "/data",
    model: env["CHAD_MODEL"],
    openaiApiUrl: env["CHAD_OPENAI_API_URL"],
    openaiApiKey: env["CHAD_OPENAI_API_KEY"],
    logLevel: level ?? "Info",
    unknownLogLevel: level === undefined ? named : undefined,
  }
}
