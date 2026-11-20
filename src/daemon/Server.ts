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
import * as ModelSpec from "../ModelSpec.ts"
import * as Paths from "../Paths.ts"
import type { LoginKind } from "../ModelText.ts"
import {
  AntigravityLoginFailed,
  type HoldEvent,
  type LoginEvent,
  type RepoEvent,
  LoginFailed,
  type ModelEvent,
  type ModelState,
  ModelUnchanged,
  type Phase,
  type Recent,
  type Report,
  Rpcs,
  type SettingItem,
  layerVersionCheck,
  sessionHeader,
} from "../Rpcs.ts"
import * as Status from "../Status.ts"
import * as Version from "../Version.ts"
import type { AntigravityLogin } from "./AntigravityLogin.ts"
import type * as Apply from "./Apply.ts"
import type { Commands } from "./Connections.ts"
import * as Filesystem from "./Filesystem.ts"
import * as Logger from "./Logger.ts"
import type * as Login from "./Login.ts"
import type * as Model from "./Model.ts"
import * as Queue from "./Queue.ts"
import type { Volume } from "./Volume.ts"

/** What the daemon knows about itself as it boots and runs. The boot writes it and the `Status` call reads it. */
export interface State {
  phase: Phase
  /** When the stop began, in milliseconds since the epoch, or nothing before a stop. */
  stopping: number | undefined
  filesystem: ReadonlyArray<string>
  connections: ReadonlyArray<{ readonly name: string; readonly kind: string }>
  /** The connection and owner commands, which the boot hands over once it has loaded the connections. */
  readonly commands: Deferred.Deferred<Commands>
  /** The fibers of the commands in flight, which a stop interrupts before it takes anything down. */
  readonly calls: Set<Fiber.Fiber<unknown, unknown>>
  /** When the daemon started, in milliseconds since the epoch. */
  readonly started: number
  /**
   * The standing conditions "Problems" lists that the daemon answers from memory or from files, each once. None reads
   * the database, so `/status` shows them when it cannot be used.
   */
  readonly problems: Array<() => ReadonlyArray<string>>
  /** The lines "Problems" reads from the `notices` table for the table keys, once the database is open. */
  held: Effect.Effect<ReadonlyArray<string>, unknown> | undefined
  /** What "Recent" reads from the `turns` table, once the database is open. */
  recent: Effect.Effect<RecentTurns, unknown> | undefined
  /** The model and the login, which the boot hands over once it has loaded them. */
  readonly account: Deferred.Deferred<Account>
  /** The loaded plugins' counts, which the boot hands over once it has loaded them. */
  plugins: () => ReadonlyArray<{
    readonly name: string
    readonly counts: {
      readonly warnings: number
      readonly errors: number
      readonly latest: string | undefined
    }
    readonly previous?: string
    readonly settings: ReadonlyArray<SettingItem>
  }>
  /** The plugins the applied `chad.json` turns off, once the plugins load. */
  off: () => ReadonlyArray<string>
  /** How many timers each plugin has, once the boot has the database. */
  timers: Effect.Effect<
    ReadonlyArray<{ readonly plugin: string; readonly count: number }>,
    unknown
  >
  /** Safe mode, the applied commit and the draft as `chad status` shows them, once the repo is set up. */
  repositoryState: Effect.Effect<Status.Repository | undefined>
  /** The commands that change what is loaded from the repo, which the boot hands over once the plugins load. */
  readonly repository: Deferred.Deferred<Apply.Commands>
  /** The one queue for everything that changes what is loaded, which the boot hands over with the commands. */
  readonly queue: Deferred.Deferred<Queue.Queue>
  /** Abandons a swap that runs, which a stop does before anything else. */
  abandon: Effect.Effect<void>
  /** The plugins skipped at boot and why, which the boot hands over with the counts. */
  skipped: () => ReadonlyArray<{
    readonly name: string
    readonly reason: string
  }>
  /** The repo skills that hide a bundled one, once the repo is set up. */
  hiding: () => ReadonlyArray<string>
  /** Each MCP server's state, once the boot has read `mcp.json`. */
  mcp: Effect.Effect<ReadonlyArray<Messages.McpServerState>>
  /** The MCP servers whose close has not ended, which a stop cut by its deadline names. */
  open: () => ReadonlyArray<string>
}

/** What `chad login`, `chad logout` and `chad status` reach of the model in the daemon. */
export interface Account {
  readonly login: Login.Login["Service"]
  readonly antigravity: AntigravityLogin["Service"]
  readonly models: Model.Models["Service"]
  /** The main setting in force, and the login its provider needs. */
  readonly model: () => {
    readonly spec: string
    readonly login: LoginKind | undefined
  }
  /** Whether a login's token is stored. */
  readonly stored: (login: LoginKind) => Effect.Effect<boolean>
}

/** Whether a login waits on the owner. */
export const pending = (account: Account, login: LoginKind) =>
  login === "codex" ? account.login.pending() : account.antigravity.pending()

/** The model and its login state, as `chad status` shows them. */
export const modelState = (account: Account): Effect.Effect<ModelState> =>
  Effect.gen(function* () {
    const { spec, login } = account.model()
    if (login === undefined) return { spec, login: "not-needed" } as const
    if (pending(account, login)) return { spec, login: "pending" } as const
    return {
      spec,
      login: (yield* account.stored(login)) ? "logged-in" : "logged-out",
    } as const
  })

/** Where a login that `chad model` or `/model` needs tells its code, as `Login.login` takes it. */
export interface LoginPrompt {
  readonly print: (prompt: Login.Prompt) => Effect.Effect<void>
  readonly leader?: Login.SessionRef
}

/**
 * `chad model` and `/model` in the daemon, which run the one call and print the same text. With no
 * change it shows the settings and the login state. A change logs `command.ran` with how it ended.
 */
export const modelCommand = (
  account: Account,
  request: ModelSpec.Request,
  caller: string,
  prompt: LoginPrompt,
): Effect.Effect<string, ModelSpec.Unchanged> =>
  Effect.gen(function* () {
    if (ModelSpec.isShow(request)) {
      const state = yield* modelState(account)
      return ModelSpec.shown(
        account.models.settings(),
        Status.logins[state.login],
      )
    }
    const login = account.login.login(prompt.print, prompt.leader).pipe(
      Effect.asVoid,
      Effect.mapError(
        (error) =>
          new ModelSpec.Unchanged({
            text: Messages.modelLoginFailed(
              error._tag === "LoginTimedOut" ? "TimedOut" : error.reason,
            ),
          }),
      ),
    )
    return yield* account.models.change(request, login).pipe(
      Effect.tapError(() => Queue.ran("model", caller, "refused")),
      Effect.tap(() => Queue.ran("model", caller, "changed")),
    )
  })

/** What "Recent" reads from the database. */
export type RecentTurns = Exclude<Recent, { readonly unavailable: string }>

export const makeState = (): State => ({
  phase: "starting",
  stopping: undefined,
  filesystem: [],
  connections: [],
  commands: Deferred.makeUnsafe(),
  repository: Deferred.makeUnsafe(),
  queue: Deferred.makeUnsafe(),
  abandon: Effect.void,
  account: Deferred.makeUnsafe(),
  calls: new Set(),
  started: Date.now(),
  problems: [],
  held: undefined,
  recent: undefined,
  plugins: () => [],
  off: () => [],
  timers: Effect.succeed([]),
  skipped: () => [],
  hiding: () => [],
  mcp: Effect.succeed([]),
  open: () => [],
  repositoryState: Effect.undefined,
})

/**
 * Interrupts the commands in flight. A stop does this first, so that a command is cut while the daemon still holds
 * what it uses, and its CLI is told the daemon went away instead of getting what a half-closed daemon answered.
 */
export const interruptCalls = (state: State) => Fiber.interruptAll(state.calls)

/**
 * "Recent", or why it is missing. A database that cannot be read leaves the rest of the answer as it is, so `/status`
 * renders with no database and no model.
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

/** The table keys' lines. With no database to read, "Problems" has the live keys alone. */
const held = (state: State): Effect.Effect<ReadonlyArray<string>> =>
  state.held === undefined
    ? Effect.succeed([])
    : state.held.pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

/** The model's line, once the boot has loaded the models. */
const model = (state: State): Effect.Effect<ModelState | undefined> =>
  Deferred.isDoneUnsafe(state.account)
    ? Effect.flatMap(Deferred.await(state.account), modelState)
    : Effect.undefined

const report = (state: State): Effect.Effect<Report> =>
  Effect.map(
    Effect.all([
      recent(state),
      held(state),
      model(state),
      // `/status` holds its effect from before the boot sets the repo up, so the field is read when the report is.
      Effect.suspend(() => state.repositoryState),
      Effect.suspend(() => state.mcp),
      Effect.suspend(() => state.timers).pipe(
        Effect.orElseSucceed(
          (): ReadonlyArray<{ plugin: string; count: number }> => [],
        ),
      ),
    ]),
    ([recent, held, model, repository, mcp, timers]) => {
      // A timer of a plugin that is not loaded is held. One of a plugin that is off or deleted from the repo shows on
      // the plugin's line, and any other, a skipped plugin's or one safe mode keeps out, under "Problems".
      const loaded = new Set(state.plugins().map(({ name }) => name))
      const off = new Set(state.off())
      const skipped = new Set(state.skipped().map(({ name }) => name))
      const safe = repository !== undefined && repository.safe !== "off"
      const unloaded = timers.filter(({ plugin }) => !loaded.has(plugin))
      const problem = ({ plugin }: { readonly plugin: string }) =>
        !off.has(plugin) && (skipped.has(plugin) || safe)
      const shown = unloaded
        .filter((entry) => !problem(entry))
        .map(({ plugin, count }) => ({ plugin, count }))
      return {
        version: Version.version,
        effect: Version.effect() ?? "unknown",
        phase: state.phase,
        filesystem: state.filesystem,
        connections: state.connections,
        started: state.started,
        problems: [
          ...state.problems.flatMap((check) => check()),
          ...held,
          ...unloaded
            .filter(problem)
            .map(({ plugin, count }) =>
              Messages.timersHeldProblem(plugin, count),
            ),
        ],
        recent,
        ...(model === undefined ? {} : { model }),
        plugins: state
          .plugins()
          .map(({ name, counts, previous, settings }) => ({
            name,
            warnings: counts.warnings,
            errors: counts.errors,
            ...(counts.latest === undefined ? {} : { latest: counts.latest }),
            ...(previous === undefined ? {} : { previous }),
            settings,
          })),
        off: state.off(),
        ...(shown.length === 0 ? {} : { held: shown }),
        skipped: state.skipped(),
        hiding: state.hiding(),
        ...(mcp.length === 0 ? {} : { mcp }),
        ...(repository === undefined ? {} : { repository }),
      }
    },
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
  /** A call that takes no place in the queue, which a stop still interrupts. */
  const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.withFiber<A, E, R>((fiber) => {
      state.calls.add(fiber)
      return effect.pipe(
        Effect.ensuring(Effect.sync(() => state.calls.delete(fiber))),
      )
    })
  return Rpcs.toLayer({
    Ping: () => Effect.succeed("pong"),
    // A killed CLI ends this stream and its wait with it, and the login runs on in the daemon.
    Login: (_, { headers }) =>
      Stream.callback<LoginEvent, LoginFailed>((queue) =>
        tracked(
          Effect.gen(function* () {
            const { login } = yield* account
            const outcome = yield* login.login((prompt) =>
              Mailbox.offer(queue, { _tag: "Code", ...prompt }).pipe(
                Effect.asVoid,
              ),
            )
            yield* Queue.ran(
              "login",
              Queue.caller(headers[sessionHeader]),
              outcome === "logged-in" ? "changed" : "unchanged",
            )
            yield* Mailbox.offer(queue, { _tag: "Ended", outcome })
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
    Repository: ({ request }, { headers }) =>
      Stream.callback<RepoEvent>((queue) =>
        tracked(
          Effect.gen(function* () {
            const repository = yield* Deferred.await(state.repository)
            const output = yield* repository.run(
              request,
              { session: headers[sessionHeader] },
              (text) =>
                Mailbox.offer(queue, { _tag: "Waiting", text }).pipe(
                  Effect.asVoid,
                ),
              (stdout) =>
                Mailbox.offer(queue, { _tag: "Printed", stdout }).pipe(
                  Effect.asVoid,
                ),
            )
            yield* Mailbox.offer(queue, { _tag: "Ended", ...output })
            yield* Mailbox.end(queue)
          }),
        ),
      ),
    // The place in the queue is held until the CLI ends the call, or goes away, which interrupts it.
    Backup: () =>
      Stream.callback<HoldEvent>((events) =>
        tracked(
          Effect.gen(function* () {
            const queue = yield* Deferred.await(state.queue)
            const busy = queue.busy()
            if (busy !== undefined) {
              yield* Mailbox.offer(events, {
                _tag: "Waiting",
                text: Messages.queueWaiting(busy),
              })
            }
            return yield* queue.run(
              Effect.andThen(
                Mailbox.offer(events, { _tag: "Held" }),
                Effect.never,
              ),
              "chad backup",
            )
          }),
        ),
      ),
    BackupFailed: ({ error }, { headers }) =>
      Logger.event("backup.failed", "chad backup failed", {
        error,
        caller: Queue.caller(headers[sessionHeader]),
      }),
    // A sign-in that a CLI killed after this call leaves waiting runs on until a newer one or the timeout ends it.
    AntigravityLoginStart: () =>
      tracked(
        Effect.gen(function* () {
          const { antigravity } = yield* account
          return { url: yield* antigravity.start }
        }).pipe(
          Effect.mapError(
            (error) => new AntigravityLoginFailed({ message: error.message }),
          ),
        ),
      ),
    AntigravityLoginFinish: ({ code }, { headers }) =>
      tracked(
        Effect.gen(function* () {
          const { antigravity } = yield* account
          const models = yield* antigravity
            .finish(code)
            .pipe(
              Effect.tapError(() =>
                Queue.ran(
                  "login",
                  Queue.caller(headers[sessionHeader]),
                  "refused",
                  { login: "antigravity" },
                ),
              ),
            )
          yield* Queue.ran(
            "login",
            Queue.caller(headers[sessionHeader]),
            "changed",
            { login: "antigravity" },
          )
          return { models }
        }).pipe(
          Effect.mapError(
            (error) => new AntigravityLoginFailed({ message: error.message }),
          ),
        ),
      ),
    ModelLogin: () =>
      tracked(Effect.map(account, (current) => current.model())),
    Logout: ({ login }, { headers }) =>
      tracked(
        Effect.gen(function* () {
          const current = yield* account
          // A stored token is cleared whatever the model in force is.
          yield* login === "codex"
            ? current.login.logout
            : current.antigravity.logout
          yield* Queue.ran(
            "logout",
            Queue.caller(headers[sessionHeader]),
            "changed",
            { login },
          )
        }),
      ),
    // A killed CLI ends this stream, and a change that has not reached its store with it. A login it started runs on
    // in the daemon.
    Model: ({ request }, { headers }) =>
      Stream.callback<ModelEvent, ModelUnchanged>((queue) =>
        tracked(
          Effect.gen(function* () {
            const text = yield* modelCommand(
              yield* account,
              request,
              Queue.caller(headers[sessionHeader]),
              {
                print: (prompt) =>
                  Mailbox.offer(queue, { _tag: "Code", ...prompt }).pipe(
                    Effect.asVoid,
                  ),
              },
            )
            yield* Mailbox.offer(queue, { _tag: "Ended", text })
            yield* Mailbox.end(queue)
          }).pipe(
            Effect.catch((error) =>
              Mailbox.fail(queue, new ModelUnchanged({ text: error.text })),
            ),
          ),
        ),
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
