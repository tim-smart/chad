// The scenario driver of layer 3. It starts the fakes and one daemon in the test's own process, through the test
// entry, and gives a scenario its volume, the fakes and the daemon's log.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Effect, Exit, Layer, Scope } from "effect"
import type { ChatTest } from "effect/chat"
import { HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { onTestFinished } from "vitest"
import * as Chat from "../../dist/daemon/Chat.js"
import type { Connection } from "../../dist/daemon/Connection.js"
import * as LocalChat from "../../dist/daemon/LocalChat.js"
import * as Cli from "./cli.ts"
import * as Discord from "./discord.ts"
import { start } from "./entry.ts"
import * as Fakes from "./fakes.ts"
import * as Model from "./model.ts"
import * as Platform from "./platform.ts"

/**
 * Where the scenarios of this run keep their directories. The path is short, because a unix socket path holds at
 * most 107 bytes on Linux and a runner's temporary directory is long. The run id comes from the vitest config.
 */
export const runs = join(
  "/tmp",
  `chad-${process.env["CHAD_TEST_RUN"] ?? "run"}`,
)

/** The id of the owner on the one connection a scenario gets, unless it names others. */
export const owner = "owner"

/** One line of `logs/chad.log`. */
export interface LogLine {
  readonly timestamp: string
  readonly level: string
  readonly message: string
  readonly annotations: Readonly<Record<string, unknown>>
}

export interface Options {
  /** The daemon's connections. The default is one `local` connection whose owner is `owner`. */
  readonly connections?: ReadonlyArray<Connection>
  /**
   * How the daemon and the scenario reach the fakes. `direct` is the same process with no socket. `socket` is the
   * product's adapter client and the test-only requests, both over `run/local.sock`. `client` is the product's
   * adapter client with no platform, for a scenario that starts the platform itself.
   */
  readonly transport?: "direct" | "socket" | "client"
  /** Environment variables for this daemon, over the driver's own. `undefined` unsets one. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Set by a live item only. A `discord` connection then reaches the real Discord: the real WebSocket constructor, and
   * Discord's own REST root in place of the fake REST server.
   */
  readonly live?: boolean
  /** A directory from `fresh` that the scenario prepared, or an earlier scenario's, to boot on its volume. */
  readonly directory?: string
  /** A chat platform that is slow to come up: no connection loads before this resolves, so the boot stays loading. */
  readonly loading?: Promise<void>
}

export interface Scenario {
  /** The scenario's own directory, which holds its event log and its volume. */
  readonly directory: string
  /** The data volume, which holds the daemon's log and the database. */
  readonly data: string
  readonly fakes: Fakes.Fakes
  /** The chat fake itself, for what needs no verb in the interface, such as `failNext` and `calls`. */
  readonly chat: ChatTest.ChatTest["Service"]
  /** Discord's two ends for a `discord` connection: the scripted gateway and the fake REST server. */
  readonly discord: {
    readonly gateway: Discord.Gateway
    readonly rest: Discord.Rest
  }
  /** The URL of every request the daemon has made through the `HttpClient` it was given. */
  readonly requests: () => ReadonlyArray<string>
  /** The lines the daemon has logged so far. */
  readonly log: () => ReadonlyArray<LogLine>
  /** Waits for a log line with the event name, and gives the first one that passes `where`. */
  readonly logged: (
    event: string,
    where?: (line: LogLine) => boolean,
  ) => Promise<LogLine>
  /** The daemon's exit code, once it has ended. */
  readonly exit: Promise<number>
  /** Stops the daemon as a SIGTERM does, and gives its exit code. */
  readonly stop: () => Promise<number>
  /** The environment a `chad` command of this scenario runs in, which never carries the daemon's `CHAD_SESSION`. */
  readonly environment: () => NodeJS.ProcessEnv
  /**
   * Runs the built `chad` on this scenario's volume as the owner at a shell does, and gives what it printed and its
   * exit code. `env` goes over the owner's environment.
   */
  readonly chad: (
    args: ReadonlyArray<string>,
    env?: Readonly<Record<string, string | undefined>>,
  ) => Promise<Cli.Ran>
}

let count = 0

/** A new scenario directory, for a scenario that puts something on the volume before the daemon starts. */
export const fresh = () => join(runs, `${process.pid}-${++count}`)

/**
 * A client that reaches the fakes and fails a request to any other host. A request to Discord's REST root goes to the
 * fake Discord REST server. It notes every request by the URL the daemon asked for.
 */
export const httpClient = (
  fakes: { readonly model: string; readonly discord: string },
  requests: Array<string> = [],
  live = false,
) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const hosts = [fakes.model, live ? Discord.restRoot : fakes.discord].map(
        (url) => new URL(url).host,
      )
      // This runs on the request as it leaves, after the base URL a caller prepends.
      return HttpClient.make((request) => {
        requests.push(request.url)
        const sent =
          !live && request.url.startsWith(Discord.restRoot)
            ? HttpClientRequest.setUrl(
                request,
                fakes.discord + request.url.slice(Discord.restRoot.length),
              )
            : request
        return hosts.includes(new URL(sent.url).host)
          ? client.execute(sent)
          : Effect.die(
              new Error(
                `the daemon asked for ${request.url}, which is no fake`,
              ),
            )
      })
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici))

export const scenario = async (options: Options = {}): Promise<Scenario> => {
  const directory = options.directory ?? fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  const record = (kind: string, fields: object) =>
    appendFileSync(
      join(directory, "events.jsonl"),
      JSON.stringify({ at: Date.now(), kind, ...fields }) + "\n",
    )

  const model = await Model.start()
  const scope = Effect.runSync(Scope.make())
  const platform = await Effect.runPromise(
    Platform.make(record).pipe(Scope.provide(scope)),
  )
  const local = Fakes.direct(platform, model)
  const transport = options.transport ?? "direct"

  // The daemon reads its environment when it starts, so the driver's values are in place only for that call.
  const variables: Record<string, string | undefined> = {
    CHAD_DATA: data,
    CHAD_MODEL: "openai-compat/fake",
    CHAD_OPENAI_API_URL: model.url,
    CHAD_OPENAI_API_KEY: "fake-key",
    ...options.env,
  }
  const saved = Object.keys(variables).map(
    (name) => [name, process.env[name]] as const,
  )
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const [name, value] of Object.entries(variables)) set(name, value)
  const requests: Array<string> = []
  const discord = { gateway: Discord.gateway(), rest: await Discord.rest() }
  record("daemon", { state: "starting", transport })
  const exit = start({
    // A `discord` connection always gets the product's adapter, over the scripted gateway and the fake REST server.
    chat: (connection) => {
      const layer =
        transport === "direct" && connection.kind === "local"
          ? platform.layer
          : Chat.layer(connection)
      const { loading } = options
      return loading === undefined
        ? layer
        : Layer.unwrap(
            Effect.as(
              Effect.promise(() => loading),
              layer,
            ),
          )
    },
    httpClient: httpClient(
      { model: model.url, discord: discord.rest.url },
      requests,
      options.live === true,
    ),
    // The one WebSocket a daemon opens so far is the gateway's. A Codex model's arrives with its slice.
    webSocketConstructor:
      options.live === true
        ? NodeSocket.layerWebSocketConstructor
        : discord.gateway.layer,
    connections: options.connections ?? [
      { name: "local", kind: "local", owners: [owner] },
    ],
  })
  for (const [name, value] of saved) set(name, value)
  void exit.then((code) => record("daemon", { state: "ended", code }))

  const log = (): ReadonlyArray<LogLine> => {
    try {
      return readFileSync(join(data, "logs/chad.log"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const logged: Scenario["logged"] = async (event, where = () => true) => {
    for (;;) {
      const line = log().find(
        (line) => line.annotations["event"] === event && where(line),
      )
      if (line !== undefined) return line
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  let stopped: Promise<number> | undefined
  const stop = () => {
    // The daemon's handler is the one this reaches. No signal is sent, so the runner's own process is left alone.
    stopped ??= (process.emit("SIGTERM"), exit)
    return stopped
  }

  let fakes = local
  if (transport === "socket") {
    // The platform starts listening after the daemon is up, so the adapter client has had nothing to connect to.
    await Promise.race([logged("boot.ready"), exit])
    const path = join(data, "run/local.sock")
    await Effect.runPromise(
      Layer.buildWithScope(
        Platform.serve(
          LocalChat.Rpcs.merge(Fakes.Rpcs),
          Layer.merge(platform.handlers, Fakes.handlers(local)),
          path,
        ),
        scope,
      ),
    )
    // The client's socket lives as long as the scenario, so its Layer is built into the scenario's scope.
    const client = await Effect.runPromise(
      Effect.gen(function* () {
        const protocol = yield* Layer.buildWithScope(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(NodeSocket.layerNet({ path })),
            Layer.provide(RpcSerialization.layerNdjson),
          ),
          scope,
        )
        return yield* RpcClient.make(Fakes.Rpcs).pipe(
          Effect.provideContext(protocol),
          Scope.provide(scope),
        )
      }),
    )
    fakes = Fakes.remote(client)
  }

  onTestFinished(async ({ task }) => {
    await stop()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    // A later scenario on the same directory has removed it by now, if the test passed.
    if (existsSync(directory)) {
      record("model", { calls: model.calls() })
      record("discord", { calls: discord.rest.calls() })
    }
    await model.close()
    await discord.rest.close()
    // A scenario that failed keeps its directory, database included, for CI to upload.
    if (task.result?.state === "pass") {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  return {
    directory,
    data,
    fakes,
    chat: platform.chat,
    discord,
    requests: () => requests,
    log,
    logged,
    exit,
    stop,
    environment: () => Cli.owner(),
    chad: (args, env = {}) => Cli.chad(args, { CHAD_DATA: data, ...env }),
  }
}
