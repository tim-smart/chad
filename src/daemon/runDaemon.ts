import { writeFileSync } from "node:fs"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "clanka/Agent"
import { Cause, Duration, Effect, Exit, Layer, Option, Scope } from "effect"
import { Chat, type ChatAdapter, type ChatHandler } from "effect/chat"
import { SingleRunner } from "effect/cluster"
import type { HttpClient } from "effect/http"
import type { Socket } from "effect/socket"
import type { SqlClient } from "effect/sql"
import * as Messages from "../Messages.ts"
import { Timings } from "../Timings.ts"
import { version } from "../Version.ts"
import type { Connection } from "./Connection.ts"
import * as Environment from "./Environment.ts"
import * as Handler from "./Handler.ts"
import * as Logger from "./Logger.ts"
import * as Model from "./Model.ts"
import * as SessionEntity from "./SessionEntity.ts"
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
  /** The chat connections and their owner ids, until the `cli` slice stores them. */
  readonly connections: ReadonlyArray<Connection>
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

/** The steps of a boot. It gives the exit code of a boot that was refused, and never returns from one that was not. */
const boot = Effect.fnUntraced(function* (
  inputs: DaemonInputs,
  environment: Environment.Environment,
  file: Logger.FileSink,
) {
  const started = Date.now()
  const volume = Volume.make(environment.data)
  if (environment.unknownLogLevel !== undefined) {
    yield* Logger.event(
      "boot.log-level-unknown",
      "CHAD_LOG_LEVEL names no level, so chad uses info",
      { value: environment.unknownLogLevel },
    )
  }

  // The start-up check writes nothing, so a boot refused here leaves the volume and the log file as they were.
  const unwritable = Volume.check(volume)
  if (unwritable !== undefined) {
    yield* Logger.event("boot.refused", unwritable, { reason: "volume" })
    return 1
  }
  Volume.prepare(volume)
  file.open(volume.log)
  yield* Logger.event("boot.started", "chad serve started", {
    version,
    node: process.version,
    data: volume.data,
  })

  const scope = yield* Effect.scope
  const base = yield* Layer.buildWithScope(
    Layer.mergeAll(
      Storage.layer(volume),
      NodeServices.layer,
      NodeCrypto.layerDigest,
      inputs.httpClient,
      inputs.webSocketConstructor,
    ),
    scope,
  )

  // The guard runs before the migrations, so a boot it refuses changes nothing in the database.
  const changed = yield* Storage.guard.pipe(
    Effect.as(Option.none<Storage.ShardCountChanged>()),
    Effect.catchTag("ShardCountChanged", (error) =>
      Effect.succeed(Option.some(error)),
    ),
    Effect.provide(base),
  )
  if (Option.isSome(changed)) {
    const { stored, now } = changed.value
    yield* Logger.event(
      "boot.refused",
      Messages.shardCountChanged(stored, now),
      { reason: "shards", stored, now },
    )
    return 1
  }
  const migrated = yield* Storage.migrate.pipe(Effect.provide(base))
  if (migrated.length > 0) {
    yield* Logger.event("database.migrated", "The database was migrated", {
      migrations: migrated.map(([id, name]) => `${id}_${name}`).join(","),
    })
  }
  writeFileSync(volume.version, version + "\n")

  const model = Model.layer(environment).pipe(
    Option.map(Layer.provide(inputs.httpClient)),
  )
  const cluster = SingleRunner.layer({
    shardingConfig: {
      shardsPerGroup: Storage.shards,
      entityMessagePollInterval: inputs.timings.messagePoll,
      entityTerminationTimeout: inputs.timings.stopRequests,
    },
  })
  const connections = inputs.connections.map((connection) =>
    inputs.chat(connection).pipe(Layer.provide(Handler.layer(connection))),
  )
  yield* Layer.buildWithScope(
    Layer.mergeAll(SessionEntity.layer, ...connections).pipe(
      Layer.provide(cluster),
      Layer.provide(Chat.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SessionEntity.Model, model),
          Layer.succeed(Volume.Volume, volume),
          Layer.succeed(Timings, inputs.timings),
          Agent.ConversationMode.layer(true),
          Layer.succeedContext(base),
        ),
      ),
    ),
    scope,
  )
  yield* Logger.event("boot.ready", "chad is ready", {
    duration_ms: Date.now() - started,
    connections: inputs.connections.length,
  })
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

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make()
    const code = yield* boot(inputs, environment, file).pipe(
      Scope.provide(scope),
      Effect.catchCause((cause) =>
        Logger.event("boot.refused", "chad serve failed", {
          reason: "failed",
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(1)),
      ),
      Effect.raceFirst(Effect.as(signalled, 0)),
    )
    // From here the stop has until the deadline, and then the process exits whatever is still open.
    const deadline = setTimeout(
      () => process.exit(1),
      Duration.toMillis(inputs.timings.stopDeadline),
    )
    yield* Scope.close(scope, Exit.void)
    clearTimeout(deadline)
    return code
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
