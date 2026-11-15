import { dirname } from "node:path"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { Data, Deferred, Effect, Fiber, FileSystem, Layer } from "effect"
import {
  type Rpc,
  type RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/rpc"
import { SocketServer } from "effect/socket"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import {
  type Phase,
  type Report,
  Rpcs,
  layerVersionCheck,
  sessionHeader,
} from "../Rpcs.ts"
import * as Status from "../Status.ts"
import * as Version from "../Version.ts"
import type { Commands } from "./Connections.ts"
import * as Filesystem from "./Filesystem.ts"
import * as Logger from "./Logger.ts"
import * as Queue from "./Queue.ts"
import type { Volume } from "./Volume.ts"

/** What the daemon knows about itself as it boots and runs. The boot writes it and the `Status` call reads it. */
export interface State {
  phase: Phase
  filesystem: ReadonlyArray<string>
  connections: ReadonlyArray<{ readonly name: string; readonly kind: string }>
  /** The connection and owner commands, which the boot hands over once it has loaded the connections. */
  readonly commands: Deferred.Deferred<Commands>
  /** The fibers of the commands in flight, which a stop interrupts before it takes anything down (CLI-19). */
  readonly calls: Set<Fiber.Fiber<unknown, unknown>>
}

export const makeState = (): State => ({
  phase: "starting",
  filesystem: [],
  connections: [],
  commands: Deferred.makeUnsafe(),
  calls: new Set(),
})

/**
 * Interrupts the commands in flight. A stop does this first, so that a command is cut while the daemon still holds
 * what it uses, and its CLI is told the daemon went away instead of getting what a half-closed daemon answered.
 */
export const interruptCalls = (state: State) => Fiber.interruptAll(state.calls)

const report = (state: State): Report => ({
  version: Version.version,
  effect: Version.effect() ?? "unknown",
  phase: state.phase,
  filesystem: state.filesystem,
  connections: state.connections,
})

/** The text `chad status` prints for a daemon that answers, which `/status` posts as it is. */
export const statusText = (state: State): string =>
  Status.render({ daemon: "up", report: report(state) })

/** The daemon could not listen on its socket. The message is the exit message. */
export class SocketRefused extends Data.TaggedError("SocketRefused")<{
  readonly message: string
}> {}

/**
 * The exit message for a `listen` that failed. An address in use and a directory the daemon may not write are named
 * as they are, and every other error means a filesystem that cannot hold a unix socket. `type` is the type of the
 * filesystem that holds the socket's directory.
 */
export const listenFailure = (
  volume: Pick<Volume, "data" | "socket">,
  code: string,
  type: string,
): string =>
  code === "EADDRINUSE" || code === "EACCES"
    ? Messages.socketFailed(volume.socket, code)
    : Messages.socketUnsupported(
        volume.socket,
        code,
        dirname(volume.socket),
        type,
        volume.data,
      )

/**
 * The unix socket. The path is checked before anything touches it, a socket file that a killed daemon left is
 * removed, and the socket gets mode 0600 after `listen`, by a chmod and with the process umask left alone. The
 * daemon holds its lock by now, so the file it removes is never a live daemon's.
 */
export const listen = (volume: Pick<Volume, "data" | "socket">) =>
  Layer.effect(
    SocketServer.SocketServer,
    Effect.gen(function* () {
      const long = Paths.socketTooLong(volume.socket)
      if (long !== undefined) {
        return yield* new SocketRefused({
          message: Messages.socketPathTooLong(
            volume.socket,
            long.bytes,
            long.limit,
          ),
        })
      }
      const fs = yield* FileSystem.FileSystem
      yield* Effect.orDie(fs.remove(volume.socket, { force: true }))
      const server = yield* NodeSocketServer.make({ path: volume.socket }).pipe(
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            const cause = error.reason.cause as
              NodeJS.ErrnoException | undefined
            return yield* new SocketRefused({
              message: listenFailure(
                volume,
                cause?.code ?? "unknown",
                yield* Filesystem.typeOf(dirname(volume.socket)),
              ),
            })
          }),
        ),
      )
      yield* Effect.orDie(fs.chmod(volume.socket, 0o600))
      return server
    }),
  )

/**
 * Serves a group of calls on the socket server, as newline-delimited JSON. A call that is interrupted because its
 * client went away writes `rpc.cancelled`, and no call's request or response is logged.
 */
export const serve = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  state: Pick<State, "phase">,
) =>
  Layer.effectDiscard(
    Effect.forkScoped(
      RpcServer.make(group, {
        onRequest: (effect, request) =>
          Effect.onInterrupt(effect, () =>
            // A stop interrupts the calls too, and that is no client going away.
            state.phase === "stopping"
              ? Effect.void
              : Logger.event(
                  "rpc.cancelled",
                  "A call was cancelled because its client went away",
                  { call: request.tag },
                ),
          ),
      }),
    ),
  ).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
  )

/** What each call does. A call that is added to the group gets its handler here. */
const handlers = (state: State) => {
  // A command that arrives while the daemon boots waits for the boot.
  const commands = Deferred.await(state.commands)
  const command = <A, E>(run: (commands: Commands) => Effect.Effect<A, E>) =>
    Effect.withFiber((fiber) => {
      state.calls.add(fiber)
      return Effect.flatMap(commands, run).pipe(
        Effect.ensuring(Effect.sync(() => state.calls.delete(fiber))),
      )
    })
  return Rpcs.toLayer({
    Ping: () => Effect.succeed("pong"),
    Status: () => Effect.sync(() => report(state)),
    ConnectionChange: ({ change }, { headers }) =>
      command((commands) =>
        commands.change(change, Queue.caller(headers[sessionHeader])),
      ),
    ConnectionList: () => command((commands) => commands.list),
    ConnectionCheck: ({ name }) => command((commands) => commands.check(name)),
  })
}

/** The daemon's RPC server, listening on the volume's socket. */
export const layer = (volume: Pick<Volume, "data" | "socket">, state: State) =>
  serve(Rpcs, state).pipe(
    Layer.provide(handlers(state)),
    Layer.provide(layerVersionCheck()),
    Layer.provide(listen(volume)),
  )
