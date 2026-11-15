import { readFileSync } from "node:fs"
import { Console, Duration, Effect } from "effect"
import { Command } from "effect/cli"
import * as Paths from "../../Paths.ts"
import * as Status from "../../Status.ts"
import { Timings } from "../../Timings.ts"
import { version } from "../../Version.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"

/** What `state/version` holds, which the CLI reads with or without a daemon. */
const volumeVersion = (data: string): string | undefined => {
  try {
    return readFileSync(Paths.version(data), "utf8").trim()
  } catch {
    return undefined
  }
}

/** `chad status`: what the daemon says about itself, and what the files say when it does not answer. */
export const status = Command.make(
  "status",
  {},
  Effect.fn("status")(function* () {
    const environment = yield* Environment
    const fromFiles = { version, volume: volumeVersion(environment.data) }
    if ((yield* Daemon.lock) === "free") {
      yield* Console.log(
        Status.render({
          daemon: "none",
          lock: environment.lock,
          ...fromFiles,
        }),
      )
      return yield* new Failure({ code: ExitCode.daemon })
    }
    const timings = yield* Timings
    const answered = yield* Daemon.answer(
      "status",
      timings.cliAnswer,
      (client) => client.Status(),
    ).pipe(Effect.option)
    if (answered._tag === "None") {
      yield* Console.log(
        Status.render({
          daemon: "silent",
          socket: environment.socket,
          seconds: Duration.toSeconds(timings.cliAnswer),
          ...fromFiles,
        }),
      )
      return yield* new Failure({ code: ExitCode.daemon })
    }
    yield* Console.log(
      Status.render({ daemon: "up", report: answered.value.answer }),
    )
  }),
).pipe(Command.withDescription("Show what the daemon is doing"))
