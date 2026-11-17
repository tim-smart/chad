import { join } from "node:path"
import { Console, Effect, Stream } from "effect"
import type { RepoRequest } from "../Rpcs.ts"
import * as Daemon from "./Daemon.ts"
import { ExitCode, Failure } from "./Failure.ts"

/** The repo under the data directory, as the daemon names it. */
export const repoOf = (data: string) => join(data, "repo")

/**
 * A command that changes what is loaded from the repo, run in the daemon. The CLI prints that it waits when another
 * command holds the queue, then what the daemon gives it, and exits with the daemon's code.
 */
export const through = (command: string, request: RepoRequest) =>
  Effect.gen(function* () {
    const client = yield* Daemon.reach(command)
    let code: 0 | 1 = 0
    let stderr: ReadonlyArray<string> = []
    yield* Daemon.call(
      command,
      client.Repository({ request }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event._tag === "Waiting")
              return yield* Console.error(event.text)
            if (event._tag === "Printed")
              return yield* Console.log(event.stdout.join("\n"))
            if (event.stdout.length > 0)
              yield* Console.log(event.stdout.join("\n"))
            code = event.code
            stderr = event.stderr
          }),
        ),
      ),
    )
    if (code !== 0) {
      return yield* new Failure({
        code: ExitCode.failed,
        ...(stderr.length === 0 ? {} : { message: stderr.join("\n") }),
      })
    }
  })
