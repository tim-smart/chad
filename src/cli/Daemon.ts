import * as NodeSocket from "@effect/platform-node/NodeSocket"
import {
  Cause,
  Duration,
  Effect,
  Layer,
  Predicate,
  Schedule,
  type Scope,
} from "effect"
import { RpcClient, type RpcGroup, RpcSerialization } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import * as Lock from "../Lock.ts"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import { type Refused, Rpcs, sessionHeader, versionHeader } from "../Rpcs.ts"
import { Timings } from "../Timings.ts"
import { version } from "../Version.ts"
import { Environment } from "./Environment.ts"
import { ExitCode, Failure } from "./Failure.ts"

/**
 * How a client command tells a running daemon from none, and how it reaches the one that runs. Every command that
 * talks to the daemon goes through here.
 */

/** The client of the daemon's calls. */
export type Client = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof Rpcs>,
  RpcClientError
>

/**
 * The headers every call of this CLI carries: its version, and the `CHAD_SESSION` it runs under when it has one. The
 * daemon refuses nothing for a session, and uses the id to name the caller.
 */
export const headers = (session?: string): Record<string, string> => ({
  [versionHeader]: version,
  ...(session === undefined ? {} : { [sessionHeader]: session }),
})

/** The lock test. A free lock means that no daemon runs on the volume. */
export const lock = Effect.gen(function* () {
  const environment = yield* Environment
  return Lock.test(environment.lock)
})

/** What a command says when the lock is free and it needs the daemon. */
export const missing = Effect.fn("Daemon.missing")(function* (command: string) {
  const environment = yield* Environment
  return new Failure({
    code: ExitCode.daemon,
    message: Messages.noDaemon(command, environment.lock),
  })
})

/** A client on the daemon's socket. It connects once and never retries. */
const connect = Effect.gen(function* () {
  const environment = yield* Environment
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Layer.provide(NodeSocket.layerNet({ path: environment.socket })),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
  )
  const client: Client = yield* RpcClient.make(Rpcs).pipe(
    Effect.provideContext(protocol),
  )
  return client
})

/** The error code of the system call under a failed connect, which effect wraps in a reason or a cause. */
const errno = (error: unknown): string | undefined => {
  let cause = error
  for (let depth = 0; depth < 4; depth++) {
    if (
      Predicate.hasProperty(cause, "code") &&
      Predicate.isString(cause.code)
    ) {
      return cause.code
    }
    if (Predicate.hasProperty(cause, "reason") && cause.reason) {
      cause = cause.reason
    } else if (Predicate.hasProperty(cause, "cause")) {
      cause = cause.cause
    } else {
      return undefined
    }
  }
  return undefined
}

/**
 * Connects and makes the first call, which the daemon has `wait` to answer. The lock is held when this runs, so a
 * socket that is missing, a connection that is refused and an answer that does not come in time all mean a daemon
 * that is starting or frozen. A connect that fails with `EINVAL` gets the path-length message of `chad serve`.
 */
export const answer = <A>(
  command: string,
  wait: Duration.Duration,
  call: (client: Client) => Effect.Effect<A, RpcClientError>,
): Effect.Effect<
  { readonly client: Client; readonly answer: A },
  Failure,
  Environment | Scope.Scope
> =>
  Effect.gen(function* () {
    const environment = yield* Environment
    const silent = new Failure({
      code: ExitCode.daemon,
      message: Messages.daemonSilent(
        command,
        environment.socket,
        Duration.toSeconds(wait),
      ),
    })
    return yield* Effect.gen(function* () {
      const client = yield* connect
      return { client, answer: yield* call(client) }
    }).pipe(
      Effect.timeoutOrElse({
        duration: wait,
        orElse: () => Effect.fail(silent),
      }),
      Effect.catch((error) =>
        Effect.fail(
          error instanceof Failure
            ? error
            : errno(error) === "EINVAL"
              ? new Failure({
                  code: ExitCode.daemon,
                  message: Messages.socketPathTooLong(
                    environment.socket,
                    Buffer.byteLength(environment.socket),
                    Paths.socketLimit(),
                  ),
                })
              : silent,
        ),
      ),
    )
  })

/**
 * Reaches the daemon for a command that needs it. A free lock is no daemon. With the lock held, the daemon has to
 * answer one ping inside the CLI's wait, and after that the CLI sets no deadline of its own.
 */
export const reach = Effect.fn("Daemon.reach")(function* (command: string) {
  if ((yield* lock) === "free") return yield* yield* missing(command)
  const timings = yield* Timings
  const { client } = yield* answer(command, timings.cliAnswer, (client) =>
    client.Ping(),
  )
  return client
})

/** What the CLI says when the daemon refused a command to a CLI of another version. */
export const refused = (command: string, error: Refused): Failure =>
  new Failure({
    code: ExitCode.failed,
    message: Messages.versionMismatch(
      command,
      error.cli ?? version,
      error.daemon,
    ),
  })

/**
 * A call of a command on a daemon that was reached. A refusal for the CLI's version and a daemon that goes away
 * during the call end the command, and what the call itself fails with is left to the command. A daemon that stops
 * in good order interrupts the calls it was answering, so an interrupt that came back as the call's own exit is a
 * daemon that went away as well.
 */
export const call = <A, E, R>(
  command: string,
  effect: Effect.Effect<A, E | Refused | RpcClientError, R>,
): Effect.Effect<A, Exclude<E, Refused | RpcClientError> | Failure, R> => {
  const gone = new Failure({
    code: ExitCode.daemon,
    message: Messages.daemonGone(command),
  })
  return effect.pipe(
    Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.fail(gone)),
    Effect.catchIf(
      (error): error is Refused => Predicate.isTagged(error, "Refused"),
      (error) => Effect.fail(refused(command, error)),
    ),
    Effect.catchIf(
      (error): error is RpcClientError =>
        Predicate.isTagged(error, "RpcClientError"),
      () => Effect.fail(gone),
    ),
  ) as Effect.Effect<A, Exclude<E, Refused | RpcClientError> | Failure, R>
}
