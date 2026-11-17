// The scenario driver of layer 3. It starts the fakes and one daemon in the test's own process, through the test
// entry, and gives a scenario its volume, the fakes and the daemon's log.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Effect, Exit, Layer, Scope } from "effect"
import type { ChatTest } from "effect/chat"
import type { HttpClient } from "effect/http"
import { onTestFinished, vi } from "vitest"
import { runCli } from "../../dist/cli/runCli.js"
import * as Chat from "../../dist/daemon/Chat.js"
import type { Connection } from "../../dist/daemon/Connection.js"
import type { DaemonInputs } from "../../dist/daemon/runDaemon.js"
import * as LocalChat from "../../dist/daemon/LocalChat.js"
import { defaults, scale } from "../../dist/Timings.js"
import * as Cli from "./cli.ts"
import * as Discord from "./discord.ts"
import { type Own, start } from "./entry.ts"
import { factor } from "./factor.ts"
import * as Fakes from "./fakes.ts"
import { httpClient, webSocketConstructor } from "./http.ts"
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
  /**
   * The connections the volume gets before the daemon starts, each added with `chad connection add` and its owners
   * with `chad owner add`, as an owner does. The default is one `local` connection whose owner is `owner`. A volume
   * that holds connections already keeps them and gets none.
   */
  readonly connections?: ReadonlyArray<Connection>
  /**
   * How the daemon and the scenario reach the fakes. `direct` is the same process with no socket. `socket` is the
   * product's adapter client and the test-only requests, both over `run/local.sock`. `client` is the product's
   * adapter client with no platform, for a scenario that starts the platform itself.
   */
  readonly transport?: "direct" | "socket" | "client"
  /** Environment variables for this daemon, over the driver's own. `undefined` unsets one. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** A directory from `fresh` that the scenario prepared, or an earlier scenario's, to boot on its volume. */
  readonly directory?: string
  /** A chat platform that is slow to come up: no connection loads before this resolves, so the boot stays loading. */
  readonly loading?: Promise<void>
  /** The session idle time or the message retention of this daemon, in place of the scaled length. */
  readonly timings?: Own
  /**
   * A Codex token the fake model server issued, stored on the volume before the daemon starts as a login with the CLI
   * leaves it, but readable by others, as the store writes it under a umask of 022. `expired` stores one whose access
   * token has expired and whose refresh is good. No real login is used.
   */
  readonly codex?: "token" | "expired"
  /** The plugins handed to `runDaemon`, none by default. */
  readonly plugins?: DaemonInputs["plugins"]
  /** The bundled skills directory handed to `runDaemon`, none by default. */
  readonly skills?: string
  /** A finalizer for the chat layer of a connection, by its name, which runs when the daemon tears the connection down. */
  readonly closing?: Readonly<Record<string, Effect.Effect<void>>>
}

export interface Scenario {
  /** The scenario's own directory, which holds its event log and its volume. */
  readonly directory: string
  /** The data volume, which holds the daemon's log and the database. */
  readonly data: string
  readonly fakes: Fakes.Fakes
  /** The chat fake itself, for what needs no verb in the interface, such as `failNext` and `calls`. */
  readonly chat: ChatTest.ChatTest["Service"]
  /** Holds the platform's `getThread`, see `Platform.holdThreads`. */
  readonly holdThreads: Platform.Platform["holdThreads"]
  /** A user's click on a button of a message, and the daemon's answer to it, see `Platform.click`. */
  readonly click: Platform.Platform["click"]
  /** A click that opens a form and the form's submit, see `Platform.submit`. */
  readonly submit: Platform.Platform["submit"]
  /** A slash command, see `Platform.command`. */
  readonly command: Platform.Platform["command"]
  /** Discord's two ends for a `discord` connection: the scripted gateway and the fake REST server. */
  readonly discord: {
    readonly gateway: Discord.Gateway
    readonly rest: Discord.Rest
  }
  /** The URL of every request the daemon has made through the `HttpClient` it was given. */
  readonly requests: () => ReadonlyArray<string>
  /** The fake model server itself, for its Codex side and the check at start, which the fakes' interface does not name. */
  readonly model: Model.FakeModel
  /** The Codex token of `Options.codex`, as it was stored. */
  readonly token: Model.StoredToken | undefined
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
   * exit code. `env` goes over the owner's environment, and `input` is what the command reads on stdin.
   */
  readonly chad: (
    args: ReadonlyArray<string>,
    env?: Readonly<Record<string, string | undefined>>,
    input?: string,
  ) => Promise<Cli.Ran>
  /**
   * Runs a command on this scenario's volume through `runCli` in the test's own process, for one that reaches the
   * network by itself: its requests go to the fakes, as the daemon's do.
   */
  readonly cli: (args: ReadonlyArray<string>) => Promise<Cli.Ran>
}

let count = 0

/** A new scenario directory, for a scenario that puts something on the volume before the daemon starts. */
export const fresh = () => join(runs, `${process.pid}-${++count}`)

export { httpClient }

/**
 * Runs a command through `runCli` in the test's own process, for one that reaches the network: its requests go
 * through the client it is given, and its durations are the scaled ones. The environment is the owner's, with `env`
 * over it, for as long as `runCli` reads it.
 */
export const inProcess = async (
  args: ReadonlyArray<string>,
  client: Layer.Layer<HttpClient.HttpClient>,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Cli.Ran> => {
  const variables = { CHAD_SESSION: undefined, ...env }
  const saved = Object.keys(variables).map(
    (name) => [name, process.env[name]] as const,
  )
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  let stdout = ""
  let stderr = ""
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((...parts) => void (stdout += parts.join(" ") + "\n"))
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((...parts) => void (stderr += parts.join(" ") + "\n"))
  for (const [name, value] of Object.entries(variables)) set(name, value)
  const running = runCli({
    args,
    httpClient: client,
    timings: scale(defaults, factor),
  })
  for (const [name, value] of saved) set(name, value)
  try {
    const code = await running
    return { stdout, stderr, code }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

/**
 * A file that holds a token, outside every scenario's directory, and what removes it. Its directory's name does not
 * start with `chad-`, because CI uploads `/tmp/chad-*` when a job fails and a token has no place in what it uploads.
 */
const tokenFile = (token: string) => {
  const directory = mkdtempSync(join(tmpdir(), "token-"))
  const file = join(directory, "token")
  writeFileSync(file, token, { mode: 0o600 })
  return { file, remove: () => rmSync(directory, { recursive: true }) }
}

/**
 * Stores a connection and its owners on a volume no daemon runs on, with the commands an owner uses. A Discord
 * connection's token is checked over the network, so that command runs in the test's process, on the client it is
 * given. The rest run the real bin.
 */
export const store = async (
  data: string,
  connection: Connection,
  client: Layer.Layer<HttpClient.HttpClient>,
) => {
  const done = (what: string, ran: Cli.Ran) => {
    if (ran.code !== 0) {
      throw new Error(`${what} exited ${ran.code}: ${ran.stdout}${ran.stderr}`)
    }
  }
  const env = { CHAD_DATA: data }
  const add = ["connection", "add", connection.kind, "--name", connection.name]
  if (connection.kind === "discord") {
    const token = tokenFile(connection.token ?? "")
    try {
      done(
        "chad connection add discord",
        await inProcess([...add, "--token-file", token.file], client, env),
      )
    } finally {
      token.remove()
    }
  } else {
    done("chad connection add local", await Cli.chad(add, env))
  }
  for (const id of connection.owners) {
    done(
      "chad owner add",
      await Cli.chad(["owner", "add", connection.name, id], env),
    )
  }
}

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
  const token =
    options.codex === undefined
      ? undefined
      : model.token({ expired: options.codex === "expired" })
  if (token !== undefined) {
    const auth = join(data, "secrets", "auth")
    mkdirSync(auth, { recursive: true, mode: 0o755 })
    writeFileSync(join(auth, Model.tokenFileName), JSON.stringify(token), {
      mode: 0o644,
    })
  }
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
  const client = httpClient(
    { model: model.url, discord: discord.rest.url },
    requests,
  )
  if (!existsSync(join(data, "secrets/connections.json"))) {
    for (const connection of options.connections ?? [
      { name: "local", kind: "local", owners: [owner] },
    ]) {
      await store(data, connection, client)
    }
  }
  record("daemon", { state: "starting", transport })
  const exit = start(
    {
      // A `discord` connection always gets the product's adapter, over the scripted gateway and the fake REST server.
      chat: (connection) => {
        const made =
          transport === "direct" && connection.kind === "local"
            ? platform.layer
            : Chat.layer(connection)
        const closing = options.closing?.[connection.name]
        const layer =
          closing === undefined
            ? made
            : Layer.merge(
                made,
                Layer.effectDiscard(Effect.addFinalizer(() => closing)),
              )
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
      httpClient: client,
      // The gateway's sockets go to the scripted gateway and a Codex model's to the fake model server.
      webSocketConstructor: webSocketConstructor(
        model.socket,
        discord.gateway.layer,
      ),
      ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
      ...(options.skills === undefined ? {} : { skills: options.skills }),
    },
    options.timings,
  )
  for (const [name, value] of saved) set(name, value)
  // A later scenario on the same directory stops this daemon too, since the stop reaches every daemon of the process,
  // and it may have removed the directory before this one has ended.
  void exit.then((code) => {
    if (existsSync(directory)) record("daemon", { state: "ended", code })
  })

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
    // The client's socket lives as long as the scenario, so it is built into the scenario's scope.
    fakes = await Fakes.over(NodeSocket.layerNet({ path }), scope)
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
    holdThreads: platform.holdThreads,
    click: platform.click,
    submit: platform.submit,
    command: platform.command,
    discord,
    requests: () => requests,
    model,
    token,
    log,
    logged,
    exit,
    stop,
    environment: () => Cli.owner(),
    chad: (args, env = {}, input) =>
      Cli.chad(args, { CHAD_DATA: data, ...env }, input),
    cli: (args) => inProcess(args, client, { CHAD_DATA: data }),
  }
}
