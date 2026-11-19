import { Console, Duration, Effect, FileSystem } from "effect"
import { Command } from "effect/cli"
import * as Connections from "../../Connections.ts"
import * as Account from "../Account.ts"
import * as Messages from "../../Messages.ts"
import * as Paths from "../../Paths.ts"
import * as Repo from "../../Repo.ts"
import * as SafeMode from "../../SafeMode.ts"
import * as Status from "../../Status.ts"
import * as Repository from "../Repository.ts"
import { Timings } from "../../Timings.ts"
import { version } from "../../Version.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Flags from "../Flags.ts"

/** What `state/version` holds, which the CLI reads with or without a daemon. */
const volumeVersion = Effect.fnUntraced(function* (data: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(Paths.version(data)).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => undefined),
  )
})

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
      volume: yield* volumeVersion(environment.data),
      connections:
        stored._tag === "Success" ? Connections.listed(stored.success) : [],
      model: yield* Account.fromFiles,
    }
    const repository = {
      safe: yield* SafeMode.read(
        environment.data,
        environment.safeMode === true,
      ),
      ...(yield* Repo.state(Repository.repoOf(environment.data))),
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
          repository,
        }),
      )
      yield* unread
      return yield* new Failure({ code: ExitCode.daemon })
    }
    const timings = yield* Timings
    // The first line says a daemon that is starting or frozen, so that failure carries no line of its own. A socket
    // path that is too long keeps its line.
    const answered = yield* Daemon.answer(
      "status",
      timings.cliAnswer,
      (client) => client.Status(),
      { silent: new Failure({ code: ExitCode.daemon }) },
    ).pipe(Effect.result)
    if (answered._tag === "Failure") {
      yield* Console.log(
        show({
          daemon: "silent",
          socket: environment.socket,
          seconds: Duration.toSeconds(timings.cliAnswer),
          ...fromFiles,
          repository,
        }),
      )
      yield* unread
      return yield* answered.failure
    }
    yield* Console.log(show({ daemon: "up", report: answered.success.answer }))
  }),
).pipe(Command.withDescription("Show what the daemon is doing"))
