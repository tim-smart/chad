import { dirname } from "node:path"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "clanka/Agent"
import { CodexAuth } from "clanka/CodexAuth"
import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Result,
  Scope,
} from "effect"
import {
  type ChatAdapter,
  type ChatHandler,
  type ChatInteraction,
  ChatThread,
} from "effect/chat"
import { MessageRetention, SingleRunner } from "effect/cluster"
import type { HttpClient } from "effect/http"
import type { Socket } from "effect/socket"
import type { SqlClient } from "effect/sql"
import * as StoredConnections from "../Connections.ts"
import * as Lock from "../Lock.ts"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import * as TokenStore from "../TokenStore.ts"
import { Timings } from "../Timings.ts"
import { version } from "../Version.ts"
import type { Connection } from "./Connection.ts"
import * as Connections from "./Connections.ts"
import * as Environment from "./Environment.ts"
import * as Chats from "./Chats.ts"
import * as Filesystem from "./Filesystem.ts"
import * as Handler from "./Handler.ts"
import * as Logger from "./Logger.ts"
import * as Login from "./Login.ts"
import * as Model from "./Model.ts"
import * as Notices from "./Notices.ts"
import * as Disk from "./Disk.ts"
import * as Unusable from "./Unusable.ts"
import * as Queue from "./Queue.ts"
import * as Server from "./Server.ts"
import * as SessionEntity from "./SessionEntity.ts"
import * as Sessions from "./Sessions.ts"
import * as Storage from "./Storage.ts"
import * as Volume from "./Volume.ts"

/** The daemon's outside world. Everything else is read from the process environment when `runDaemon` starts. */
export interface DaemonInputs {
  /**
   * Gives the Layer that provides one connection's chat platform. The Layer registers the platform's adapter and
   * hands each inbound event to the `ChatHandler` it is given.
   */
  readonly chat: (
    connection: Connection,
  ) => Layer.Layer<
    never,
    never,
    | ChatAdapter.Registry
    | ChatHandler.ChatHandler
    | ChatInteraction.Handler
    | Volume.Volume
    | HttpClient.HttpClient
    | Socket.WebSocketConstructor
    | SqlClient.SqlClient
  >
  /** The client every model request, login request and Discord REST request goes through. */
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  /** The constructor the Discord gateway and the WebSocket transport of a model dial with. */
  readonly webSocketConstructor: Layer.Layer<Socket.WebSocketConstructor>
  /** One complete set of durations. */
  readonly timings: Timings
}

/** Resolves on the first SIGTERM or SIGINT, and takes its handlers off the process when it is done with. */
const signalled = Effect.callback<void>((resume) => {
  const off = () => {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
  }
  const stop = () => {
    off()
    resume(Effect.void)
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  return Effect.sync(off)
})

/**
 * The steps of a boot, in the order of the numbered list in docs/spec/01-image-and-volume.md. It gives the exit code
 * of a boot that was refused, and never returns from one that was not.
 */
const boot = Effect.fnUntraced(function* (
  inputs: DaemonInputs,
  environment: Environment.Environment,
  file: Logger.FileSink,
  state: Server.State,
  /** Node's file system, paths and child processes, which the boot itself reads the volume with. */
  platform: Context.Context<NodeServices.NodeServices>,
) {
  const fs = yield* FileSystem.FileSystem
  const started = Date.now()
  const volume = Volume.make(environment.data, environment.socket)
  if (environment.unknownLogLevel !== undefined) {
    yield* Logger.event(
      "boot.log-level-unknown",
      "CHAD_LOG_LEVEL names no level, so chad uses info",
      { value: environment.unknownLogLevel },
    )
  }

  // Step 1. The two checks write nothing, and no lock is held, so their lines are on stdout only until step 2.
  const unwritable = yield* Volume.check(volume)
  if (unwritable !== undefined) {
    yield* Logger.event("boot.refused", unwritable, { reason: "volume" })
    return 1
  }
  state.filesystem = yield* Filesystem.check(volume.data, environment.installs)
  for (const warning of state.filesystem) {
    yield* Logger.event("boot.filesystem", warning)
  }

  // Step 2. A boot that is refused the lock has touched nothing but `state/`, which holds the lock file.
  yield* fs.makeDirectory(dirname(volume.lock), { recursive: true })
  const release = Lock.take(volume.lock, inputs.timings.lockBusy)
  if (release === undefined) {
    yield* Logger.event("boot.refused", Messages.lockHeld(volume.data), {
      reason: "lock",
    })
    return 1
  }
  // Only Node's own services are in the scope before this, and a scope closes in reverse, so the lock outlives
  // everything the daemon opens.
  yield* Effect.addFinalizer(() => Effect.sync(release))
  // The log file is the daemon's from here on, and the lines stdout already has go into it first.
  yield* fs.makeDirectory(dirname(volume.log), { recursive: true })
  file.open(volume.log)
  yield* Logger.event("boot.started", "chad serve holds the lock", {
    version,
    node: process.version,
    data: volume.data,
  })

  // Steps 3 and 4, the check for a newer state/version and the boot counter, belong here.
  yield* Volume.prepare(volume)

  // The stored connections are read before the socket listens, so that status names them from its first answer.
  const stored = yield* StoredConnections.read(volume.data).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Logger.event("boot.refused", Messages.connectionsRefused(error), {
        reason: "connections",
      }).pipe(Effect.as(Option.none<ReadonlyArray<Connection>>())),
    ),
  )
  if (Option.isNone(stored)) return 1
  state.connections = StoredConnections.listed(stored.value)

  // Step 5. The socket listens before the database is opened, so status and health answer during the rest.
  const scope = yield* Effect.scope
  const socket = yield* Layer.buildWithScope(
    Server.layer(volume, state),
    scope,
  ).pipe(
    Effect.as(Option.none<Server.SocketRefused>()),
    Effect.catchTag("SocketRefused", (error) =>
      Effect.succeed(Option.some(error)),
    ),
  )
  if (Option.isSome(socket)) {
    yield* Logger.event("boot.refused", socket.value.message, {
      reason: "socket",
    })
    return 1
  }
  state.phase = "listening"

  // The outside world comes before the database, which is opened for step 6.
  const world = yield* Layer.buildWithScope(
    Layer.mergeAll(
      Layer.succeedContext(platform),
      NodeCrypto.layerDigest,
      inputs.httpClient,
      inputs.webSocketConstructor,
    ),
    scope,
  )

  // Steps 6 to 8. The guard runs before the migrations, so a boot it refuses changes nothing in the database. A
  // database that cannot be opened or migrated for any other reason keeps chad up without sessions (STO-117).
  const opened = yield* Effect.gen(function* () {
    const base = Context.merge(
      world,
      yield* Layer.buildWithScope(Storage.layer(volume), scope),
    )
    yield* Storage.guard.pipe(Effect.provide(base))
    state.phase = "database"
    yield* Storage.known.pipe(Effect.provide(base))
    const migrated = yield* Storage.migrate.pipe(Effect.provide(base))
    return { base, migrated }
  }).pipe(
    Effect.map((value) => ({ _tag: "Opened" as const, ...value })),
    Effect.catchTag("ShardCountChanged", (error) =>
      Effect.succeed({ _tag: "Changed" as const, error }),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed({ _tag: "Unusable" as const, cause }),
    ),
  )
  if (opened._tag === "Changed") {
    const { stored, now } = opened.error
    yield* Logger.event(
      "boot.refused",
      Messages.shardCountChanged(stored, now),
      { reason: "shards", stored, now },
    )
    return 1
  }
  if (opened._tag === "Unusable") {
    yield* Unusable.run({
      inputs,
      volume,
      state,
      stored: stored.value,
      world,
      cause: opened.cause,
    })
    state.phase = "ready"
    yield* Logger.event("boot.ready", "chad is ready", {
      duration_ms: Date.now() - started,
      connections: stored.value.length,
      database: "unusable",
    })
    return yield* Effect.never
  }
  const { base, migrated } = opened
  if (migrated.length > 0) {
    yield* Logger.event("database.migrated", "The database was migrated", {
      migrations: migrated.map(([id, name]) => `${id}_${name}`).join(","),
    })
  }
  // The database is usable again, so a later time it is not sends its notice again (FAIL-226, STO-186).
  yield* fs
    .remove(Paths.dbUnusable(volume.data), { force: true })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("state/db-unusable could not be removed", cause),
      ),
    )
  yield* fs.writeFileString(volume.version, version + "\n")
  // "Recent" reads the `turns` table from here on. "Today" is the day in the daemon's own timezone until the owner
  // can set one (FAIL-334).
  state.recent = Effect.suspend(() => {
    const now = Date.now()
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    return Sessions.recent({
      since: now - Duration.toMillis(inputs.timings.statusFailedWindow),
      today: today.getTime(),
      week: now - Duration.toMillis(Duration.days(7)),
    })
  }).pipe(Effect.provideContext(base))

  // Step 9.
  state.phase = "loading"
  // The token store and the one Codex login of the process, which every session's model layer is built over. clanka's
  // login reads the stored token once, as it is built (MOD-26, MOD-66).
  const tokens = yield* Layer.buildWithScope(
    TokenStore.layer(volume.data),
    scope,
  ).pipe(Effect.provide(world), Effect.orDie)
  const settings = yield* Model.read(volume.data, environment).pipe(
    Effect.provide(world),
    Effect.orDie,
  )
  const cluster = SingleRunner.layer({
    shardingConfig: {
      shardsPerGroup: Storage.shards,
      entityMessagePollInterval: inputs.timings.messagePoll,
      entityTerminationTimeout: inputs.timings.stopRequests,
    },
  })
  // Each connection has a `Chat` and an adapter registry of its own, because the registry is keyed by platform and
  // two connections can share one. A session finds the `Chat` of a connection by the connection's name.
  const running = yield* Chats.make((connection, live) =>
    inputs
      .chat(connection)
      .pipe(Layer.provide([Handler.layer(live), Handler.interactions(live)])),
  )
  // The notices outside a turn post through the connections, and "Problems" lists their keys from here on.
  const notices = yield* Notices.make({
    data: volume.data,
    quiet: inputs.timings.noticeQuiet,
    post: Notices.post(running.chats, running.list),
    direct: Notices.directMessage(running.chats, running.list),
  }).pipe(Effect.provideContext(base))
  state.problems.push(notices.problems)
  // The one Codex login of the process. Its code goes to the thread of the turn that asked, or by the notice route,
  // and its wait is the daemon's, so a turn or a CLI that goes does not end it (MOD-36, MOD-41, MOD-101).
  const login = yield* Login.make({
    timeout: inputs.timings.modelLogin,
    announce: (text) =>
      notices.announce(text).pipe(
        Effect.flatMap((destination) =>
          destination === undefined
            ? Effect.succeed(undefined)
            : Effect.map(
                running.chats.format(destination.connection),
                (format) =>
                  Option.match(ChatThread.fromString(destination.thread), {
                    onNone: () => undefined,
                    onSome: format.link,
                  }),
              ),
        ),
        Effect.orElseSucceed(() => undefined),
      ),
  }).pipe(Effect.provide(Context.merge(world, tokens)))
  const requirements = Context.mergeAll(
    world,
    tokens,
    Context.make(CodexAuth, login.auth),
    Context.make(DeviceCodeHandler, Login.otherLogins),
  )
  const models = Model.make(settings, environment, requirements)
  yield* Deferred.succeed(state.account, {
    login,
    model: () => {
      const current = models.settings()
      return {
        spec: Model.text(current),
        needsLogin:
          Result.isSuccess(current.main) &&
          Model.needsLogin(current.main.success),
      }
    },
    stored: TokenStore.codexStored(volume.data).pipe(
      Effect.provideContext(world),
    ),
  })
  state.held = notices.held
  yield* Disk.start(volume.data, inputs.timings.freeSpaceInterval, notices)
  // Cluster deletes a completed request of a session once it is a day old. The `turns` row is what is left of it.
  const retention = MessageRetention.make({
    entity: SessionEntity.Session,
    retention: inputs.timings.messageRetention,
    interval: Duration.min(
      inputs.timings.messageRetention,
      Duration.minutes(1),
    ),
  })
  const sessions = yield* Layer.buildWithScope(
    Layer.merge(SessionEntity.layer, retention).pipe(
      Layer.provideMerge(cluster),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(Model.Models, models),
          Layer.succeed(Login.Login, login),
          Layer.succeed(SessionEntity.Stopping, {
            stopping: () => state.phase === "stopping",
          }),
          Layer.succeed(Handler.Status, {
            text: Server.statusText(state),
          }),
          Layer.succeed(Chats.Chats, running.chats),
          Layer.succeed(Notices.Notices, notices),
          Layer.succeed(Volume.Volume, volume),
          Layer.succeed(Timings, inputs.timings),
          Agent.ConversationMode.layer(true),
          Layer.succeedContext(base),
        ),
      ),
    ),
    scope,
  )
  // The rows of Discord shard state that a connection removed with no daemon left behind go before any gateway dials.
  yield* Connections.forget(stored.value).pipe(Effect.provide(sessions))
  yield* running.set(stored.value).pipe(Effect.provide(sessions))
  yield* Deferred.succeed(
    state.commands,
    yield* Connections.make(volume, state, running, Queue.make()).pipe(
      Effect.provide(sessions),
    ),
  )
  state.phase = "ready"
  yield* Logger.event("boot.ready", "chad is ready", {
    duration_ms: Date.now() - started,
    connections: stored.value.length,
  })
  // The check at start runs once chad is connected, and nothing waits for it (MOD-95).
  yield* Model.check({
    settings,
    endpoint: environment,
    requirements,
    deadline: inputs.timings.modelTrial,
    notices,
  }).pipe(Effect.forkIn(scope))
  return yield* Effect.never
})

/**
 * Runs the daemon until it is told to stop and gives its exit code. It owns the parts that belong to the process:
 * the signals, the exit timer, the exit codes and `CHAD_SESSION=daemon`. It takes its handlers off the process and
 * puts the environment back when it ends, so a test can run one daemon after another in its own process.
 */
export const runDaemon = (inputs: DaemonInputs): Promise<number> => {
  const environment = Environment.read(process.env)
  const session = process.env["CHAD_SESSION"]
  process.env["CHAD_SESSION"] = "daemon"
  const file = Logger.makeFileSink()
  const state = Server.makeState()

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make()
    const platform = yield* Layer.buildWithScope(NodeServices.layer, scope)
    const code = yield* boot(inputs, environment, file, state, platform).pipe(
      Effect.provide(platform),
      Scope.provide(scope),
      Effect.catchCause((cause) =>
        Logger.event("boot.refused", "chad serve failed", {
          reason: "failed",
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(1)),
      ),
      Effect.raceFirst(Effect.as(signalled, "signal" as const)),
    )
    const at = Date.now()
    state.phase = "stopping"
    if (code === "signal") {
      yield* Logger.event("stop.started", "chad is stopping", {})
    }
    // From here the stop has until the deadline, and then the process exits whatever is still open.
    const deadline = setTimeout(
      () => process.exit(1),
      Duration.toMillis(inputs.timings.stopDeadline),
    )
    yield* Server.interruptCalls(state)
    yield* Scope.close(scope, Exit.void)
    clearTimeout(deadline)
    if (code !== "signal") return code
    yield* Logger.event("stop.ended", "chad stopped", {
      duration_ms: Date.now() - at,
    })
    return 0
  })

  return Effect.runPromise(
    program.pipe(
      Effect.provide(Logger.layer({ level: environment.logLevel, file })),
    ),
  ).finally(() => {
    if (session === undefined) delete process.env["CHAD_SESSION"]
    else process.env["CHAD_SESSION"] = session
  })
}
