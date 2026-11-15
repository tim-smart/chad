import { chmodSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { Data, Effect, Layer } from "effect"
import {
  type Rpc,
  type RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/rpc"
import { SocketServer } from "effect/socket"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import { type Phase, type Report, Rpcs, layerVersionCheck } from "../Rpcs.ts"
import * as Version from "../Version.ts"
import * as Filesystem from "./Filesystem.ts"
import * as Logger from "./Logger.ts"
import type { Volume } from "./Volume.ts"

/** What the daemon knows about itself as it boots and runs. The boot writes it and the `Status` call reads it. */
export interface State {
  phase: Phase
  filesystem: ReadonlyArray<string>
  connections: ReadonlyArray<{ readonly name: string; readonly kind: string }>
}

export const makeState = (): State => ({
  phase: "starting",
  filesystem: [],
  connections: [],
})

const report = (state: State): Report => ({
  version: Version.version,
  effect: Version.effect() ?? "unknown",
  phase: state.phase,
  filesystem: state.filesystem,
  connections: state.connections,
})

/** The daemon could not listen on its socket. The message is the exit message. */
export class SocketRefused extends Data.TaggedError("SocketRefused")<{
  readonly message: string
}> {}

/**
 * The exit message for a `listen` that failed. An address in use and a directory the daemon may not write are named
 * as they are, and every other error means a filesystem that cannot hold a unix socket.
 */
export const listenFailure = (
  volume: Pick<Volume, "data" | "socket">,
  code: string,
  type: (directory: string) => string = Filesystem.typeOf,
): string => {
  const directory = dirname(volume.socket)
  return code === "EADDRINUSE" || code === "EACCES"
    ? Messages.socketFailed(volume.socket, code)
    : Messages.socketUnsupported(
        volume.socket,
        code,
        directory,
        type(directory),
        volume.data,
      )
}

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
      yield* Effect.sync(() => rmSync(volume.socket, { force: true }))
      const server = yield* NodeSocketServer.make({ path: volume.socket }).pipe(
        Effect.mapError((error) => {
          const cause = error.reason.cause as NodeJS.ErrnoException | undefined
          return new SocketRefused({
            message: listenFailure(volume, cause?.code ?? "unknown"),
          })
        }),
      )
      yield* Effect.sync(() => chmodSync(volume.socket, 0o600))
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
const handlers = (state: State) =>
  Rpcs.toLayer({
    Ping: () => Effect.succeed("pong"),
    Status: () => Effect.sync(() => report(state)),
  })

/** The daemon's RPC server, listening on the volume's socket. */
export const layer = (volume: Pick<Volume, "data" | "socket">, state: State) =>
  serve(Rpcs, state).pipe(
    Layer.provide(handlers(state)),
    Layer.provide(layerVersionCheck()),
    Layer.provide(listen(volume)),
  )
