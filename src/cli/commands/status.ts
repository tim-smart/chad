import { readFileSync } from "node:fs"
import { Console, Duration, Effect } from "effect"
import { Command } from "effect/cli"
import * as Connections from "../../Connections.ts"
import * as Messages from "../../Messages.ts"
import * as Paths from "../../Paths.ts"
import * as Status from "../../Status.ts"
import { Timings } from "../../Timings.ts"
import { version } from "../../Version.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Flags from "../Flags.ts"

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
  { json: Flags.boolean("json") },
  Effect.fn("status")(function* ({ json }) {
    const show = json ? Status.json : Status.render
    const environment = yield* Environment
    // What the files say is read whether or not a daemon answers, and printed when none does.
    const stored = yield* Connections.read(environment.data).pipe(Effect.result)
    const fromFiles = {
      version,
      volume: volumeVersion(environment.data),
      connections:
        stored._tag === "Success" ? Connections.listed(stored.success) : [],
    }
    const unread =
      stored._tag === "Failure"
        ? Console.error(Messages.connectionRejected("status", stored.failure))
        : Effect.void
    if ((yield* Daemon.lock) === "free") {
      yield* Console.log(
        show({
          daemon: "none",
          lock: environment.lock,
          ...fromFiles,
        }),
      )
      yield* unread
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
        show({
          daemon: "silent",
          socket: environment.socket,
          seconds: Duration.toSeconds(timings.cliAnswer),
          ...fromFiles,
        }),
      )
      yield* unread
      return yield* new Failure({ code: ExitCode.daemon })
    }
    yield* Console.log(show({ daemon: "up", report: answered.value.answer }))
  }),
).pipe(Command.withDescription("Show what the daemon is doing"))
