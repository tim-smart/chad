import { Console, Effect } from "effect"
import { Command } from "effect/cli"
import * as Messages from "../../Messages.ts"
import { Timings } from "../../Timings.ts"
import * as Daemon from "../Daemon.ts"

/** `chad health`: the lock test, then one ping. It prints one line and checks nothing else. */
export const health = Command.make(
  "health",
  {},
  Effect.fn("health")(function* () {
    if ((yield* Daemon.lock) === "free") {
      return yield* yield* Daemon.missing("health")
    }
    const timings = yield* Timings
    yield* Daemon.answer("health", timings.healthPing, (client) =>
      client.Ping(),
    )
    yield* Console.log(Messages.healthy())
  }),
).pipe(Command.withDescription("Say whether the daemon is alive"))
