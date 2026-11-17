import { Data } from "effect"

/** The exit codes of the client commands. */
export const ExitCode = {
  /** Done. */
  done: 0,
  /** The command ran and failed. */
  failed: 1,
  /** Bad usage. */
  usage: 2,
  /** Refused as an owner command, because `CHAD_SESSION` is set. */
  owner: 3,
  /** The daemon is needed and is missing or silent. */
  daemon: 4,
  /** Interrupted by a signal. */
  interrupted: 130,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

/**
 * How a command ends when it does not end well: the exit code, and the line for stderr unless the command has
 * printed what there is to say.
 */
export class Failure extends Data.TaggedError("Failure")<{
  /** One of the codes of `ExitCode`, or, for `chad secret run`, any code its child exits with. */
  readonly code: ExitCode | number
  readonly message?: string
}> {}
