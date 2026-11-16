import { Context } from "effect"
import * as Paths from "../Paths.ts"

/**
 * What a client command takes from the environment. The CLI finds the volume and the socket the way the daemon does.
 * `runCli` reads the process environment once, when the command starts.
 */
export interface Environment {
  /** `CHAD_DATA`, the data directory. */
  readonly data: string
  /** `CHAD_SOCKET`, or `run/chad.sock` on the volume. */
  readonly socket: string
  /** The daemon lock's file. */
  readonly lock: string
  /** `CHAD_SESSION`, which marks a command that the agent or the daemon runs. The owner's shell has none. */
  readonly session: string | undefined
  /** `CHAD_MODEL`, the main model when no override is stored. */
  readonly model?: string | undefined
  /** Whether `CHAD_OPENAI_API_KEY` is set, which puts `openai` on the API and off the Codex login. */
  readonly openaiApiKey?: string | undefined
  /** `CHAD_OPENAI_API_URL`, the endpoint of a trial request `chad model` makes with no daemon. */
  readonly openaiApiUrl?: string | undefined
  /** Whether `CHAD_SAFE_MODE=1` is set, which holds safe mode on. */
  readonly safeMode?: boolean
  /** `TZ`, the owner's timezone when none is stored. */
  readonly tz?: string | undefined
  /** The whole environment the CLI started with, which a child of `chad secret run` inherits. */
  readonly inherited: Readonly<Record<string, string | undefined>>
}

export const Environment = Context.Service<Environment>("chad/cli/Environment")

export const read = (env: NodeJS.ProcessEnv): Environment => {
  const data = Paths.data(env)
  return {
    data,
    socket: Paths.socket(env),
    lock: Paths.lock(data),
    session: env["CHAD_SESSION"],
    inherited: env,
    model: env["CHAD_MODEL"],
    openaiApiKey: env["CHAD_OPENAI_API_KEY"],
    openaiApiUrl: env["CHAD_OPENAI_API_URL"],
    safeMode: env["CHAD_SAFE_MODE"] === "1",
    tz: env["TZ"],
  }
}
