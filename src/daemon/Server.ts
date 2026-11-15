import { dirname } from "node:path"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Stream,
} from "effect"
import * as Mailbox from "effect/Queue"
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
  type LoginEvent,
  LoginFailed,
  type ModelState,
  type Phase,
  type Recent,
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
import type * as Login from "./Login.ts"
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
  /** When the daemon started, in milliseconds since the epoch. */
  readonly started: number
  /**
   * The standing conditions "Problems" lists that the daemon answers from memory or from files, each once. None reads
   * the database, so `/status` shows them when it cannot be used (FAIL-112, FAIL-213, CLI-211).
   */
  readonly problems: Array<() => ReadonlyArray<string>>
  /** The lines "Problems" reads from the `notices` table for the table keys, once the database is open (FAIL-308). */
  held: Effect.Effect<ReadonlyArray<string>, unknown> | undefined
  /** What "Recent" reads from the `turns` table, once the database is open (FAIL-114). */
  recent: Effect.Effect<RecentTurns, unknown> | undefined
  /** The model and the login, which the boot hands over once it has loaded them. */
  readonly account: Deferred.Deferred<Account>
}

/** What `chad login`, `chad logout` and `chad status` reach of the model in the daemon. */
export interface Account {
  readonly login: Login.Login["Service"]
  /** The main setting in force, and whether its provider needs the Codex login. */
  readonly model: () => { readonly spec: string; readonly needsLogin: boolean }
  /** Whether a Codex token is stored. */
  readonly stored: Effect.Effect<boolean>
}

/** The model and its login state, as `chad status` shows them (CLI-125). */
export const modelState = (account: Account): Effect.Effect<ModelState> =>
  Effect.gen(function* () {
    const { spec, needsLogin } = account.model()
    if (!needsLogin) return { spec, login: "not-needed" } as const
    if (account.login.pending()) return { spec, login: "pending" } as const
    return {
      spec,
      login: (yield* account.stored) ? "logged-in" : "logged-out",
    } as const
  })

/** What "Recent" reads from the database. */
export type RecentTurns = Exclude<Recent, { readonly unavailable: string }>

export const makeState = (): State => ({
  phase: "starting",
  filesystem: [],
  connections: [],
  commands: Deferred.makeUnsafe(),
  account: Deferred.makeUnsafe(),
  calls: new Set(),
  started: Date.now(),
  problems: [],
  held: undefined,
  recent: undefined,
})

/**
 * Interrupts the commands in flight. A stop does this first, so that a command is cut while the daemon still holds
 * what it uses, and its CLI is told the daemon went away instead of getting what a half-closed daemon answered.
 */
export const interruptCalls = (state: State) => Fiber.interruptAll(state.calls)

/**
 * "Recent", or why it is missing. A database that cannot be read leaves the rest of the answer as it is, so `/status`
 * renders with no database and no model (FAIL-111, CLI-149).
 */
const recent = (state: State): Effect.Effect<Recent> =>
  state.recent === undefined
    ? Effect.succeed({ unavailable: "the database is not open yet" })
    : state.recent.pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({
            unavailable: `the database could not be read: ${Messages.firstLine(Cause.pretty(cause))}`,
          }),
        ),
      )

/** The table keys' lines. With no database to read, "Problems" has the live keys alone (FAIL-309). */
const held = (state: State): Effect.Effect<ReadonlyArray<string>> =>
  state.held === undefined
    ? Effect.succeed([])
    : state.held.pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

/** The model's line, once the boot has loaded the models. */
const model = (state: State): Effect.Effect<ModelState | undefined> =>
  Deferred.isDoneUnsafe(state.account)
    ? Effect.flatMap(Deferred.await(state.account), modelState)
    : Effect.succeed(undefined)

const report = (state: State): Effect.Effect<Report> =>
  Effect.map(
    Effect.all([recent(state), held(state), model(state)]),
    ([recent, held, model]) => ({
      version: Version.version,
      effect: Version.effect() ?? "unknown",
      phase: state.phase,
      filesystem: state.filesystem,
      connections: state.connections,
      started: state.started,
      problems: [...state.problems.flatMap((check) => check()), ...held],
      recent,
      ...(model === undefined ? {} : { model }),
    }),
  )

/** The text `chad status` prints for a daemon that answers, which `/status` posts as it is. */
export const statusText = (state: State): Effect.Effect<string> =>
  Effect.map(report(state), (report) => Status.render({ daemon: "up", report }))

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
  const account = Deferred.await(state.account)
  /** A call that takes no place in the queue, which a stop still interrupts (CLI-159, CLI-19). */
  const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.withFiber<A, E, R>((fiber) => {
      state.calls.add(fiber)
      return effect.pipe(
        Effect.ensuring(Effect.sync(() => state.calls.delete(fiber))),
      )
    })
  return Rpcs.toLayer({
    Ping: () => Effect.succeed("pong"),
    // A killed CLI ends this stream and its wait with it, and the login runs on in the daemon (MOD-59, MOD-101).
    Login: (_, { headers }) =>
      Stream.callback<LoginEvent, LoginFailed>((queue) =>
        tracked(
          Effect.gen(function* () {
            const { login, model } = yield* account
            const { spec, needsLogin } = model()
            const outcome = needsLogin
              ? yield* login.login((prompt) =>
                  Mailbox.offer(queue, { _tag: "Code", ...prompt }).pipe(
                    Effect.asVoid,
                  ),
                )
              : "not-needed"
            yield* Queue.ran(
              "login",
              Queue.caller(headers[sessionHeader]),
              outcome === "logged-in" ? "changed" : "unchanged",
            )
            yield* Mailbox.offer(queue, { _tag: "Ended", outcome, spec })
            yield* Mailbox.end(queue)
          }).pipe(
            Effect.catch((error) =>
              Mailbox.fail(
                queue,
                new LoginFailed({
                  reason:
                    error._tag === "LoginTimedOut" ? "TimedOut" : error.reason,
                }),
              ),
            ),
          ),
        ),
      ),
    Logout: (_, { headers }) =>
      tracked(
        Effect.gen(function* () {
          const { login, model } = yield* account
          // A stored token is cleared whatever the model in force is (MOD-110).
          yield* login.logout
          yield* Queue.ran(
            "logout",
            Queue.caller(headers[sessionHeader]),
            "changed",
          )
          return { spec: model().spec }
        }),
      ),
    Status: () => report(state),
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
