import { Effect } from "effect"
import * as Messages from "../Messages.ts"
import { Environment } from "./Environment.ts"
import { ExitCode, Failure } from "./Failure.ts"

/**
 * The refusal of an owner command. A set `CHAD_SESSION` marks a command the agent or the daemon runs, whatever its
 * value, and an unset one is the owner's shell. It is no security boundary, and only the CLI refuses.
 */
export const only = Effect.fn("Owner.only")(function* (command: string) {
  const environment = yield* Environment
  if (environment.session !== undefined) {
    return yield* new Failure({
      code: ExitCode.owner,
      message: Messages.ownerRefused(command, environment.session),
    })
  }
})
