import { dirname } from "node:path"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
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
  Chat,
  type ChatAdapter,
  type ChatHandler,
  type ChatInteraction,
  ChatMarkdown,
  ChatThread,
} from "effect/chat"
import { MessageRetention, SingleRunner } from "effect/cluster"
import type { HttpClient } from "effect/http"
import type { Socket } from "effect/socket"
import type { SqlClient } from "effect/sql"
import * as StoredConnections from "../Connections.ts"
import * as Lock from "../Lock.ts"
import * as Messages from "../Messages.ts"
import * as ModelSpec from "../ModelSpec.ts"
import * as Paths from "../Paths.ts"
import * as Repo from "../Repo.ts"
import * as SafeMode from "../SafeMode.ts"
import * as Settings from "../Settings.ts"
import * as TokenStore from "../TokenStore.ts"
import { Timings } from "../Timings.ts"
import { version } from "../Version.ts"
import type { Connection } from "./Connection.ts"
import * as Connections from "./Connections.ts"
import * as Environment from "./Environment.ts"
import * as Chats from "./Chats.ts"
import * as Filesystem from "./Filesystem.ts"
import * as Apply from "./Apply.ts"
import * as Loader from "./Loader.ts"
import * as Handler from "./Handler.ts"
import * as Logger from "./Logger.ts"
import * as Login from "./Login.ts"
import * as Model from "./Model.ts"
import * as Notices from "./Notices.ts"
import * as PluginTurns from "./PluginTurns.ts"
import * as Plugins from "./Plugins.ts"
import * as PluginSettings from "./PluginSettings.ts"
import * as Disk from "./Disk.ts"
import * as Unusable from "./Unusable.ts"
import * as Queue from "./Queue.ts"
import * as RepoLinks from "./RepoLinks.ts"
import * as Server from "./Server.ts"
import * as SessionEntity from "./SessionEntity.ts"
import * as Sessions from "./Sessions.ts"
import * as Spawner from "./Spawner.ts"
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
  /** The plugins the daemon loads at boot, which `chad serve` gives as the bundled ones (LOAD-74). */
  readonly plugins?: ReadonlyArray<Plugins.Entry> | undefined
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
    // Whether safe mode is on and why (FAIL-286b).
    safe: yield* SafeMode.read(volume.data, environment.safeMode),
  })

  // Step 3, the check for a newer state/version, belongs here.
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
  // A volume with no chat connection runs, and says that setup is needed (IMG-33, CLI-6, FAIL-288).
  if (stored.value.length === 0) {
    yield* Logger.event("boot.setup-needed", Messages.setupNeeded, {})
  }

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
  // The plugins of the applied tree load beside the bundled ones, through the bundle loader and with no type-check
  // (LOAD-61). They are bundled before any session or connection starts, and their Layers build once the sessions
  // can take turns. `repo/`'s links come first, so the agent finds the packages and the examples (IMG-44 to IMG-46).
  yield* RepoLinks.prepare(volume.repo)
  // Safe mode is read from its file and the variable, never from the database (STO-15, REC-56, REC-57).
  const safe = yield* SafeMode.read(volume.data, environment.safeMode)
  // The repo with its first commit when there is none, and `live` on the head of `applied`, which wins over what
  // `live` named. No file in the repo stops a boot, so a repo that cannot be readied loads nothing (IMG-43, LOAD-89,
  // REC-48, REC-121).
  const applied = yield* Repo.prepare(volume.repo).pipe(
    Effect.tapCause((cause) =>
      Effect.logWarning(
        "The repo could not be readied, so nothing loads from it",
        cause,
      ),
    ),
    Effect.option,
  )
  const bundledNames = new Set((inputs.plugins ?? []).map(({ name }) => name))
  const fromRepo =
    // Safe mode loads nothing from the repo and never starts esbuild (LOAD-63, LOAD-90, REC-50).
    safe !== "off" || Option.isNone(applied)
      ? { loaded: [], skipped: [] }
      : // A repo plugin with a bundled plugin's name is skipped before it runs, since the two would share one table
        // (REC-42).
        yield* Loader.load(applied.value.directory, bundledNames)
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
  // The applied `chad.json`, which no file can make stop the boot. A plugin it turns off is not loaded and is not
  // skipped (SET-34, SET-57, SET-58, LOAD-63, FAIL-315).
  const appliedSettings = yield* PluginSettings.atBoot({
    tree: Option.isSome(applied) ? applied.value.directory : undefined,
    known: new Set([
      ...bundledNames,
      ...fromRepo.loaded.map(({ name }) => name),
      ...fromRepo.skipped.map(({ name }) => name),
    ]),
    safe: safe !== "off",
    notices,
  })
  const off = Settings.off(appliedSettings)
  for (const name of off) yield* notices.clear(Plugins.skippedKey(name))
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
    loggedIn: Effect.andThen(
      notices.clear(Notices.usageLimitKey),
      notices.clear(Notices.loggedOutKey),
    ),
  }).pipe(Effect.provide(Context.merge(world, tokens)))
  const requirements = Context.mergeAll(
    world,
    tokens,
    Context.make(CodexAuth, login.auth),
    Context.make(DeviceCodeHandler, Login.otherLogins),
  )
  const models = Model.make({
    initial: settings,
    data: volume.data,
    inputs: environment,
    requirements,
    deadline: inputs.timings.modelTrial,
    changed: notices.clear(Model.checkKey),
  })
  const account: Server.Account = {
    login,
    models,
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
  }
  yield* Deferred.succeed(state.account, account)
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
  // The plugins are loaded once the sessions can take their turns, and every turn waits for them. Their scope is
  // forked here, so it closes after the sessions' and a graceful stop runs their queued hooks after the turns end
  // (API-67).
  const pluginScope = yield* Scope.fork(scope)
  let repository: Apply.Commands | undefined
  const waiting: PluginTurns.Waiting = new Map()
  let host: Plugins.Plugins["Service"] | undefined
  const loaded = yield* Deferred.make<Plugins.Plugins["Service"]>()
  const plugins: Plugins.Plugins["Service"] = {
    ready: Effect.flatMap(Deferred.await(loaded), (host) => host.ready),
    tools: (current) => host?.tools(current),
    chunks: (session) =>
      Effect.flatMap(Deferred.await(loaded), (host) => host.chunks(session)),
    beforeTurn: (turn) =>
      Effect.flatMap(Deferred.await(loaded), (host) => host.beforeTurn(turn)),
    afterTurn: (ended) =>
      Effect.flatMap(Deferred.await(loaded), (host) => host.afterTurn(ended)),
    onSession: (event) =>
      Effect.flatMap(Deferred.await(loaded), (host) => host.onSession(event)),
    status: () => host?.status() ?? [],
    skipped: () => host?.skipped() ?? [],
    generation: () => host?.generation() ?? 0,
    versions: () => host?.versions() ?? [],
    prepare: (plan) =>
      Effect.flatMap(Deferred.await(loaded), (host) => host.prepare(plan)),
    abandon: Effect.suspend(() => host?.abandon ?? Effect.void),
  }
  state.abandon = plugins.abandon
  const sessions = yield* Layer.buildWithScope(
    Layer.merge(SessionEntity.layer, retention).pipe(
      Layer.provideMerge(cluster),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(Model.Models, models),
          Layer.succeed(Login.Login, login),
          Layer.succeed(Plugins.Plugins, plugins),
          Layer.succeed(SessionEntity.Support, {
            loggedOut: Effect.gen(function* () {
              const { needsLogin } = account.model()
              return needsLogin && !login.pending() && !(yield* account.stored)
            }),
            owners: (connection) =>
              running.list().find(({ name }) => name === connection)?.owners ??
              [],
            ended: (key, outcome) => PluginTurns.ended(waiting, key, outcome),
          }),
          Layer.succeed(SessionEntity.Safe, {
            on: () =>
              (repository === undefined ? safe : repository.safe()) !== "off",
          }),
          Layer.succeed(SessionEntity.Stopping, {
            stopping: () => state.phase === "stopping",
          }),
          Layer.succeed(Handler.Status, {
            text: Server.statusText(state),
          }),
          Layer.succeed(Handler.SafeCommand, {
            run: (to, post) =>
              Deferred.await(state.repository).pipe(
                Effect.flatMap((repository) =>
                  repository.run(
                    { _tag: "Safe", to },
                    { session: undefined, chat: true },
                    post,
                  ),
                ),
                Effect.flatMap((output) =>
                  post([...output.stdout, ...output.stderr].join("\n")),
                ),
              ),
          }),
          Layer.succeed(Handler.ModelCommand, {
            run: (words, where) => modelCommand(account, scope, words, where),
          }),
          Layer.succeed(Chats.Chats, running.chats),
          Layer.succeed(Notices.Notices, notices),
          Layer.succeed(Volume.Volume, volume),
          Layer.succeed(Timings, inputs.timings),
          Agent.ConversationMode.layer(true),
          // Only a test sets clanka's turn timeout, and the shipped daemon leaves clanka's default (FAIL-79, TST-215).
          inputs.timings.turnTimeout === undefined
            ? Layer.empty
            : Agent.TurnTimeout.layer(inputs.timings.turnTimeout),
          Layer.succeedContext(base),
        ),
      ),
    ),
    scope,
  )
  // The rows of Discord shard state that a connection removed with no daemon left behind go before any gateway dials.
  yield* Connections.forget(stored.value).pipe(Effect.provide(sessions))
  yield* running.set(stored.value).pipe(Effect.provide(sessions))
  host = yield* Plugins.make({
    entries: PluginSettings.entries({
      file: appliedSettings,
      bundled: inputs.plugins ?? [],
      repo: fromRepo.loaded,
      safe: safe !== "off",
    }),
    unloadable: fromRepo.skipped.filter(({ name }) => !off.has(name)),
    lookup: PluginSettings.lookup(volume.data, environment.variables, fs),
    owners: () =>
      running
        .list()
        .flatMap((connection) =>
          connection.owners.map((id) => `${connection.kind}:${id}`),
        ),
    timings: inputs.timings,
    stopping: () => state.stopping,
    notices,
    // The trial `Agent.makeWith` of an apply, on an executor of its own, since clanka dies when two tools share a name
    // (SWAP-3).
    trial: (tools) =>
      Agent.makeWith({ loopTools: tools.toolkit }).pipe(
        Effect.provide(tools.context),
        Effect.provide(
          AgentExecutor.layerLocal({ directory: volume.home }).pipe(
            Layer.provide(Spawner.layer("trial", volume.home)),
          ),
        ),
        Effect.scoped,
        Effect.provideContext(world),
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.fail(
            Messages.firstLine(Cause.pretty(Cause.squash(cause) as never)),
          ),
        ),
      ) as Effect.Effect<void, string>,
    turns: PluginTurns.make({
      waiting,
      scope: pluginScope,
      client: yield* SessionEntity.Session.client.pipe(
        Effect.provide(sessions),
      ),
      chats: running.chats,
      connections: running.list,
    }),
  }).pipe(
    Effect.provideContext(
      Context.mergeAll(
        world,
        base,
        Context.make(Chat.Chat, PluginTurns.chat(running.chats, running.list)),
      ),
    ),
    Scope.provide(pluginScope),
  )
  yield* Deferred.succeed(loaded, host)
  const queue = Queue.make()
  const announce = PluginTurns.chat(running.chats, running.list)
  repository = yield* Apply.make({
    repo: volume.repo,
    data: volume.data,
    forced: environment.safeMode,
    initial: safe,
    plugins,
    bundled: inputs.plugins ?? [],
    settings: appliedSettings,
    notices,
    queue,
    scope,
    // A command's line goes to the thread of the session that ran it, as subtext (REC-108, FAIL-177).
    announce: (session, line) =>
      Effect.gen(function* () {
        const thread = yield* Sessions.threadOf(session)
        if (thread === undefined) return
        const parsed = ChatThread.fromString(thread)
        if (Option.isNone(parsed)) return
        yield* ChatMarkdown.post(parsed.value, `-# ${line}`).pipe(
          Effect.provideService(Chat.Chat, announce),
        )
      }).pipe(Effect.provideContext(base)),
  }).pipe(Effect.provideContext(world))
  yield* Deferred.succeed(state.repository, repository)
  const commands = repository
  state.repositoryState = Repo.state(volume.repo).pipe(
    Effect.map((facts) => ({ safe: commands.safe(), ...facts })),
    Effect.provideContext(world),
  )
  state.plugins = host.status
  state.off = () => [...commands.off()].sort()
  state.skipped = host.skipped
  yield* Deferred.succeed(
    state.commands,
    yield* Connections.make(
      volume,
      state,
      running,
      queue,
      repository.owners,
    ).pipe(Effect.provide(sessions)),
  )
  state.phase = "ready"
  yield* Logger.event("boot.ready", "chad is ready", {
    duration_ms: Date.now() - started,
    connections: stored.value.length,
  })
  // The check at start runs once chad is connected, which is when the first connection of the boot has connected, a
  // Discord one at its gateway's `READY`, and nothing waits for it (MOD-95, MOD-127). With no connection there is
  // nothing to wait for, so it runs at once.
  yield* Effect.gen(function* () {
    if (stored.value.length > 0) yield* running.chats.connected
    yield* Model.check({
      settings,
      endpoint: environment,
      requirements,
      deadline: inputs.timings.modelTrial,
      notices,
    })
  }).pipe(Effect.forkIn(scope))
  return yield* Effect.never
})

/**
 * `/model` from chat. Words it does not take get the usage line. Otherwise the command runs in a fiber of the daemon's
 * scope, so the event's handler is done at once, and posts what it prints where it was typed. A restart drops a
 * command that is still running, and nothing is said (MOD-125). A login it starts posts its code there too, and one
 * that runs already has its code posted there as well (MOD-91).
 */
const modelCommand = (
  account: Server.Account,
  scope: Scope.Scope,
  words: ReadonlyArray<string>,
  where: {
    readonly link: string
    readonly post: (markdown: string) => Effect.Effect<void>
  },
) => {
  const request = ModelSpec.parseWords(words)
  if (Result.isFailure(request)) return where.post(request.failure)
  const leader: Login.SessionRef = {
    id: `model ${where.link}`,
    ownerPresent: true,
    link: where.link,
    post: where.post,
    notice: where.post,
    waiting: Effect.void,
  }
  return Server.modelCommand(
    account,
    request.success,
    Queue.caller(undefined),
    {
      // A login this command joins prints its code here. One it starts posts the code to `leader` and prints nothing.
      print: (prompt) =>
        where.post(Messages.loginPrompt(prompt.verifyUrl, prompt.code)),
      leader,
    },
  ).pipe(
    Effect.catch((error) => Effect.succeed(error.text)),
    Effect.flatMap(where.post),
    Effect.forkIn(scope),
    Effect.asVoid,
  )
}

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
    state.stopping = at
    if (code === "signal") {
      yield* Logger.event("stop.started", "chad is stopping", {})
    }
    // From here the stop has until the deadline, and then the process exits whatever is still open.
    const deadline = setTimeout(
      () => process.exit(1),
      Duration.toMillis(inputs.timings.stopDeadline),
    )
    // A swap that runs is abandoned first, before anything waits on requests in flight (SWAP-101).
    yield* state.abandon
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
