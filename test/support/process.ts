// The process driver of layer 4 (docs/spec/17-testing.md, TST-27 and TST-28). The daemon runs as a child process
// that a scenario kills with SIGKILL, stops with SIGTERM and starts again on the same volume. The chat state and the
// model script stay here, in the test's process: the local platform listens at `run/local.sock`, the scripted
// gateway at a WebSocket server, and the fake model and the fake Discord REST server over HTTP.
import { spawn } from "node:child_process"
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import type { ChatTest } from "effect/chat"
import { onTestFinished } from "vitest"
import type { Connection } from "../../dist/daemon/Connection.js"
import * as LocalChat from "../../dist/daemon/LocalChat.js"
import type { Config } from "./child.ts"
import * as Cli from "./cli.ts"
import * as Discord from "./discord.ts"
import { fresh, type LogLine, owner, store } from "./driver.ts"
import type { Own } from "./entry.ts"
import * as Fakes from "./fakes.ts"
import { httpClient } from "./http.ts"
import * as Model from "./model.ts"
import * as Platform from "./platform.ts"
import * as Reap from "./reap.ts"

const child = fileURLToPath(new URL("./child.ts", import.meta.url))

export interface Options {
  /** The connections the volume gets before the first start. The default is one `local` connection of `owner`. */
  readonly connections?: ReadonlyArray<Connection>
  /** Environment variables for every start, over the driver's own. `undefined` unsets one. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The session idle time or the message retention, in place of the scaled length (TST-212). */
  readonly timings?: Own
  /** Starts the daemon with `--expose-gc` and a collection every 200 milliseconds (TST-105). */
  readonly gc?: boolean
}

/** How a child ended: its exit code, or the signal that killed it. */
export interface Exited {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** One start of the daemon. */
export interface Daemon {
  readonly pid: number
  readonly exit: Promise<Exited>
  /** A kill: SIGKILL, and the exit. */
  readonly kill: () => Promise<Exited>
  /** A graceful stop: SIGTERM, and the exit. */
  readonly stop: () => Promise<Exited>
  /** Sends a signal and does not wait, such as SIGSTOP. */
  readonly signal: (name: NodeJS.Signals) => void
}

export interface Process {
  readonly directory: string
  readonly data: string
  /** The environment every start gets. */
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly fakes: Fakes.Fakes
  readonly chat: ChatTest.ChatTest["Service"]
  /**
   * Ends the scenario's processes, which the end of the test does as well: the daemons, then every process that
   * carries the scenario's mark. Fails when one is still running after that.
   */
  readonly close: () => Promise<void>
  /** Holds the local platform's downloads, see `Platform.holdDownloads`. */
  readonly holdDownloads: Platform.Platform["holdDownloads"]
  readonly discord: {
    readonly gateway: Discord.Served
    readonly rest: Discord.Rest
  }
  readonly log: () => ReadonlyArray<LogLine>
  readonly logged: (
    event: string,
    where?: (line: LogLine) => boolean,
  ) => Promise<LogLine>
  /** Starts the daemon and waits until it is ready, or until it exits. */
  readonly start: () => Promise<Daemon>
  /** What every start has written to its standard output and error so far. */
  readonly output: () => string
  /** How many collections a daemon started with `gc` has forced so far. */
  readonly collections: () => number
  /** Starts the daemon and gives it at once. */
  readonly spawn: (options?: { readonly gc?: boolean }) => Daemon
  /** Runs the built `chad` on the volume as the owner does. */
  readonly chad: (
    args: ReadonlyArray<string>,
    env?: Readonly<Record<string, string | undefined>>,
    input?: string,
  ) => Promise<Cli.Ran>
}

export { alive } from "./reap.ts"

export const daemon = async (options: Options = {}): Promise<Process> => {
  const directory = fresh()
  const data = join(directory, "data")
  // The child's home, npm prefix and caches are inside the scenario's directory, next to `CHAD_DATA` (IMG-140).
  const home = join(directory, "home")
  const cache = join(directory, "cache")
  for (const path of [data, home, cache]) mkdirSync(path, { recursive: true })
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
  const fakes = Fakes.direct(platform, model)
  const discord = {
    gateway: await Discord.served(),
    rest: await Discord.rest(),
  }
  const client = httpClient({ model: model.url, discord: discord.rest.url })
  const connections = options.connections ?? [
    { name: "local", kind: "local" as const, owners: [owner] },
  ]
  for (const connection of connections) await store(data, connection, client)

  const ms = (value: Duration.Duration | undefined) =>
    value === undefined ? undefined : Duration.toMillis(value)
  const config: Config = {
    model: model.url,
    discord: discord.rest.url,
    gateway: discord.gateway.url,
    timings: {
      sessionIdle: ms(options.timings?.sessionIdle),
      messageRetention: ms(options.timings?.messageRetention),
    },
    gc: undefined,
  }
  const environment = {
    CHAD_DATA: data,
    CHAD_MODEL: "openai-compat/fake",
    CHAD_OPENAI_API_URL: model.url,
    CHAD_OPENAI_API_KEY: "fake-key",
    HOME: home,
    NPM_CONFIG_PREFIX: join(home, ".npm-global"),
    XDG_CACHE_HOME: cache,
    NPM_CONFIG_CACHE: join(cache, "npm"),
    // Every process a start leads to inherits this, a detached background process included, which is how the end of
    // the scenario finds them (TST-87).
    [Reap.scenarioVariable]: directory,
    ...options.env,
  }

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
  const wait = () => new Promise((resolve) => setTimeout(resolve, 20))
  const logged: Process["logged"] = async (event, where = () => true) => {
    for (;;) {
      const line = log().find(
        (line) => line.annotations["event"] === event && where(line),
      )
      if (line !== undefined) return line
      await wait()
    }
  }
  const readies = () =>
    log().filter((line) => line.annotations["event"] === "boot.ready").length

  const children: Array<Daemon> = []
  const tracked = Reap.tracker(directory)
  const spawned: Process["spawn"] = (start = {}) => {
    const out = openSync(join(directory, "daemon.out"), "a")
    const gc = start.gc ?? options.gc ?? false
    const running = spawn(
      process.execPath,
      [...(gc ? ["--expose-gc"] : []), child],
      {
        env: Cli.owner({
          ...environment,
          CHAD_TEST_CHILD: JSON.stringify({
            ...config,
            gc: gc ? join(directory, "collections") : undefined,
          } satisfies Config),
        }),
        stdio: ["ignore", out, out],
      },
    )
    closeSync(out)
    const exit = new Promise<Exited>((resolve) =>
      running.once("exit", (code, signal) => {
        record("daemon", { state: "ended", code, signal })
        resolve({ code, signal })
      }),
    )
    record("daemon", { state: "started", pid: running.pid })
    if (running.pid !== undefined) tracked.root(running.pid)
    // The daemon's descendants are read before a signal that can end it, while they are still its descendants.
    const signal = (name: NodeJS.Signals) => {
      if (name === "SIGKILL" || name === "SIGTERM") tracked.look()
      running.kill(name)
    }
    const started: Daemon = {
      pid: running.pid ?? 0,
      exit,
      kill: () => (signal("SIGKILL"), exit),
      stop: () => (signal("SIGTERM"), exit),
      signal: (name) => signal(name),
    }
    children.push(started)
    return started
  }

  let serving = false
  const start = async () => {
    const before = readies()
    const started = spawned()
    let ended = false
    void started.exit.then(() => (ended = true))
    while (!ended && readies() <= before) await wait()
    // The platform listens from the first start on and outlives every daemon, as a chat platform does.
    if (!ended && !serving && connections.some((c) => c.kind === "local")) {
      serving = true
      await Effect.runPromise(
        Layer.buildWithScope(
          Platform.serve(
            LocalChat.Rpcs,
            platform.handlers,
            join(data, "run/local.sock"),
          ),
          scope,
        ),
      )
    }
    return started
  }

  // The daemons, then every process the driver recorded for the scenario (`reap.ts`), so nothing a scenario started
  // outlives it. One that a SIGKILL does not end within the bound fails the scenario.
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      tracked.look()
      for (const running of children) {
        running.signal("SIGCONT")
        running.signal("SIGKILL")
        await running.exit
      }
      await tracked.reap(wait)
    })())

  onTestFinished(async ({ task }) => {
    const survivors = await close().then(
      () => undefined,
      (error: unknown) => error,
    )
    await Effect.runPromise(Scope.close(scope, Exit.void))
    if (existsSync(directory)) record("model", { calls: model.calls() })
    await model.close()
    await discord.rest.close()
    await discord.gateway.close()
    // A scenario that failed keeps its directory, database included, for CI to upload.
    if (task.result?.state === "pass" && survivors === undefined) {
      rmSync(directory, { recursive: true, force: true })
    }
    if (survivors !== undefined) throw survivors
  })

  return {
    directory,
    data,
    environment,
    fakes,
    chat: platform.chat,
    holdDownloads: platform.holdDownloads,
    close,
    discord,
    log,
    logged,
    start,
    spawn: spawned,
    output: () => readFileSync(join(directory, "daemon.out"), "utf8"),
    collections: () => {
      try {
        return Number(readFileSync(join(directory, "collections"), "utf8"))
      } catch {
        return 0
      }
    },
    chad: (args, env = {}, input) =>
      Cli.chad(args, { CHAD_DATA: data, ...env }, input),
  }
}
