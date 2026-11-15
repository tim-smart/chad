import { Effect } from "effect"
import * as Connections from "../Connections.ts"
import * as Messages from "../Messages.ts"
import * as Daemon from "./Daemon.ts"
import { Environment } from "./Environment.ts"
import { ExitCode, Failure } from "./Failure.ts"
import * as Files from "./Files.ts"
import * as Owner from "./Owner.ts"

/** How the `connection` and `owner` commands end when the store or the daemon turns one down. */
export const rejected =
  (command: string) =>
  (error: Connections.Rejected | Failure): Failure =>
    error instanceof Failure
      ? error
      : new Failure({
          code: ExitCode.failed,
          message: Messages.connectionRejected(command, error),
        })

/**
 * Makes the change of a `connection` or `owner` command. A running daemon is asked to make it, because it would not
 * see what another process wrote. With no daemon the CLI checks the token itself and writes the file while it holds
 * the lock.
 *
 * `token` reads the token of a change that carries one. It is asked for only once the change is known to go ahead
 * whatever the token is, and never while the lock is held.
 *
 * The volume's version is checked twice. The first check refuses before anything is asked for. The second runs under
 * the lock, because a newer daemon may have started and stopped while the CLI waited for the token or for Discord.
 */
export const make = <R = never>(
  command: string,
  change: Connections.Change,
  token?: Effect.Effect<string, Failure, R>,
) =>
  Effect.gen(function* () {
    yield* Owner.only(command)
    const environment = yield* Environment
    const complete: Effect.Effect<Connections.Change, Failure, R> =
      token === undefined
        ? Effect.succeed(change)
        : Effect.map(token, (token): Connections.Change =>
            change._tag === "Add" || change._tag === "Token"
              ? { ...change, token }
              : change,
          )
    if ((yield* Daemon.lock) === "held") {
      const client = yield* Daemon.reach(command)
      const full = yield* complete
      return yield* Daemon.call(
        command,
        client.ConnectionChange({ change: full }),
      )
    }
    yield* Files.writable(command)
    const stored = yield* Connections.read(environment.data)
    yield* Connections.apply(stored, change)
    const full = yield* complete
    const checked = yield* Connections.prepare(stored, full)
    return yield* Files.locked(
      command,
      Effect.gen(function* () {
        yield* Files.writable(command)
        const next = yield* Connections.apply(
          yield* Connections.read(environment.data),
          full,
        )
        if (next.changed) {
          yield* Connections.write(environment.data, next.connections)
        }
        const made: Connections.Changed = { changed: next.changed, ...checked }
        return made
      }),
    )
  }).pipe(Effect.mapError(rejected(command)))
