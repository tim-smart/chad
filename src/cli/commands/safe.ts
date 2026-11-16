import { Console, Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import * as Messages from "../../Messages.ts"
import * as SafeMode from "../../SafeMode.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Repository from "../Repository.ts"

/**
 * `chad safe [on|off]`. With a daemon it swaps; with none it reads or stores the toggle, which the next start reads.
 * While `CHAD_SAFE_MODE=1` is set, `off` changes nothing and exits 1 (REC-56, REC-128, REC-129, REC-G23).
 */
export const safe = Command.make(
  "safe",
  {
    to: Argument.Literals("to", ["on", "off"] as const).pipe(
      Argument.withDescription(
        "Turn safe mode on or off, or say whether it is on",
      ),
      Argument.optional,
    ),
  },
  Effect.fn("safe")(function* ({ to }) {
    const request = Option.getOrUndefined(to)
    if ((yield* Daemon.lock) === "held") {
      return yield* Repository.through("safe", { _tag: "Safe", to: request })
    }
    const environment = yield* Environment
    if (request === "off" && environment.safeMode === true) {
      return yield* new Failure({
        code: ExitCode.failed,
        message: Messages.safeForced,
      })
    }
    if (request !== undefined) {
      yield* SafeMode.write(environment.data, request === "on").pipe(
        Effect.mapError(
          (error) =>
            new Failure({ code: ExitCode.failed, message: error.message }),
        ),
      )
    }
    yield* Console.log(
      Messages.safeState(
        yield* SafeMode.read(environment.data, environment.safeMode === true),
      ),
    )
  }),
).pipe(Command.withDescription("Load nothing from the repo, or load it again"))
