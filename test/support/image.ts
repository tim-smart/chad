// What the image layer of the tests shares: one build of the Dockerfile, the second container that holds the fakes, and
// containers, volumes and networks that are removed when the tests end.
import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duplex, type Readable, type Writable } from "node:stream"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Effect, Exit, Layer, Scope } from "effect"
import { Socket } from "effect/socket"
import { fresh } from "./driver.ts"
import * as Bundle from "./bundle.ts"
import * as Fakes from "./fakes.ts"
import { root } from "./repo.ts"

/** The container engine. podman works where it answers to the same commands. */
export const engine = process.env["CHAD_ENGINE"] ?? "docker"

/** The image under test. */
export const image = "chad-test:image"

export interface Result {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs one engine command to its end. */
export const run = (...args: ReadonlyArray<string>): Result => {
  const { status, stdout, stderr } = spawnSync(engine, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status, stdout, stderr }
}

const succeed = (args: ReadonlyArray<string>): string => {
  const result = run(...args)
  if (result.status !== 0) {
    throw new Error(
      `${engine} ${args.join(" ")} exited ${result.status}\n${result.stdout}${result.stderr}`,
    )
  }
  return result.stdout
}

const build = (tag: string, ...flags: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(engine, ["build", ...flags, "--tag", tag, root], {
      // podman writes the OCI format unless it is told otherwise, and that format has no HEALTHCHECK. Docker does
      // not read the variable.
      env: { ...process.env, BUILDAH_FORMAT: "docker" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk) => (output += chunk))
    child.stderr.on("data", (chunk) => (output += chunk))
    child.on("error", reject)
    child.on("close", (status) =>
      status === 0
        ? resolve()
        : reject(new Error(`the build of ${tag} exited ${status}\n${output}`)),
    )
  })

let built: Promise<void> | undefined

/** Builds the image once per suite. */
export const buildImage = (): Promise<void> => (built ??= build(image))

const containers: Array<string> = []
const volumes: Array<string> = []
const networks: Array<string> = []
const unique = () => `chad-test-${randomBytes(4).toString("hex")}`

/** Creates an empty named volume. */
export const volume = (): string => {
  const name = unique()
  succeed(["volume", "create", name])
  volumes.push(name)
  return name
}

/**
 * Creates a network whose containers reach each other by name and reach nothing else, so a daemon on it has no
 * network beyond the fakes.
 */
export const network = (): string => {
  const name = unique()
  succeed(["network", "create", "--internal", name])
  networks.push(name)
  return name
}

export interface Options {
  /** Flags of `run`, such as a volume or a user. */
  readonly flags?: ReadonlyArray<string>
  readonly image?: string
}

/** Runs a shell script in a container of its own, in place of the entrypoint, and removes the container. */
export const sh = (script: string, options: Options = {}): Result =>
  run(
    "run",
    "--rm",
    ...(options.flags ?? []),
    "--entrypoint",
    "sh",
    options.image ?? image,
    "-c",
    script,
  )

/** The standard output of a script that has to pass, with its last line break taken off. */
export const output = (script: string, options: Options = {}): string => {
  const result = sh(script, options)
  if (result.status !== 0) {
    throw new Error(
      `the script exited ${result.status}\n${script}\n${result.stdout}${result.stderr}`,
    )
  }
  return result.stdout.trimEnd()
}

/** The lines of `output`. */
export const lines = (script: string, options: Options = {}) =>
  output(script, options).split("\n").filter(Boolean)

/** Runs the image's own entrypoint and command to their end and removes the container. */
export const command = (
  flags: ReadonlyArray<string>,
  ...args: ReadonlyArray<string>
): Result => run("run", "--rm", ...flags, image, ...args)

/** Starts the image with its own entrypoint and command, and gives the container's name. */
export const start = (...flags: ReadonlyArray<string>): string => {
  const name = unique()
  containers.push(name)
  succeed(["run", "--detach", "--name", name, ...flags, image])
  return name
}

/** What a container wrote, standard output and standard error apart. */
export const logs = (container: string): Result => run("logs", container)

/** Waits for a line on the container's standard output, and fails with `otherwise` when the container ends first. */
const printed = async (
  container: string,
  line: string,
  otherwise: string,
): Promise<void> => {
  const deadline = Date.now() + 60_000
  for (;;) {
    if (logs(container).stdout.includes(line)) return
    const running = run(
      "inspect",
      "--format",
      "{{.State.Running}}",
      container,
    ).stdout.trim()
    if (running !== "true" || Date.now() > deadline) {
      const { stdout, stderr } = logs(container)
      throw new Error(`${otherwise}\n${stdout}${stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Waits for the daemon's `boot.ready` line on the container's standard output. It never waits for a healthy
 * container.
 */
export const ready = (container: string): Promise<void> =>
  printed(container, "event=boot.ready", "chad serve was not ready")

/**
 * Waits until the engine reports the container healthy, which is the image's own `HEALTHCHECK` passing. Docker runs
 * the check by itself, every two seconds at the start. podman leaves that to a systemd timer, which a machine may
 * lack, so podman is told to run the check.
 */
export const healthy = async (container: string): Promise<void> => {
  const podman = /podman/i.test(run("--version").stdout)
  for (;;) {
    if (podman) run("healthcheck", "run", container)
    const status = succeed([
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      container,
    ]).trim()
    if (status === "healthy") return
    if (status === "unhealthy") {
      throw new Error("the engine reports the container unhealthy")
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** Runs a script in a running container. */
export const exec = (container: string, script: string): string =>
  succeed(["exec", container, "sh", "-c", script]).trimEnd()

/** Stops a container with the engine's stop, which sends the image's stop signal, and gives its exit code. */
export const stop = (container: string): number => {
  succeed(["stop", container])
  return Number(
    succeed(["inspect", "--format", "{{.State.ExitCode}}", container]),
  )
}

export interface Mount {
  readonly Type: string
  /** The volume's name, on a mount of a named volume. */
  readonly Name?: string
  readonly Source: string
  readonly Destination: string
  readonly RW: boolean
}

/** What the engine says of a container. Docker gives `null` where podman gives an empty list. */
export interface Container {
  /** The id of the image the container was made from. */
  readonly Image: string
  readonly Path: string
  readonly Args: ReadonlyArray<string>
  readonly Config: {
    readonly User: string
    readonly Env: ReadonlyArray<string>
  }
  readonly HostConfig: { readonly ExtraHosts: ReadonlyArray<string> | null }
  readonly Mounts: ReadonlyArray<Mount>
  readonly NetworkSettings: {
    readonly Networks: Record<string, unknown>
    /** The ports that are published or exposed. */
    readonly Ports: Record<string, unknown> | null
  }
  readonly State: { readonly Health: { readonly Status: string } }
}

export const container = (name: string): Container =>
  JSON.parse(succeed(["container", "inspect", name]))[0]

/** The second container: where it mounts its one file, and the port of its fake model server. */
export const fakesFile = "/opt/fakes.mjs"
const modelPort = 8080

let bundled: Promise<string> | undefined
let bundleDirectory: string | undefined
const scope = Scope.makeUnsafe()

/**
 * The one file of the repository that the second container is given (`Bundle.bundleFakes`). It is bundled once, into a
 * temporary directory.
 */
const bundleFakes = (): Promise<string> =>
  (bundled ??= (async () => {
    bundleDirectory = mkdtempSync(join(tmpdir(), "chad-fakes-"))
    const outfile = join(bundleDirectory, "fakes.mjs")
    await Bundle.bundleFakes(outfile)
    // The container's uid is not the one that wrote the file.
    chmodSync(outfile, 0o644)
    return outfile
  })())

/** Whether the engine keeps a network's containers from everything outside it. */
export const internal = (network: string): boolean =>
  succeed([
    "network",
    "inspect",
    "--format",
    "{{.Internal}}",
    network,
  ]).trim() === "true"

/** A name for a container that starts later, so that a container that starts first can be told it. */
export const reserve = (): string => {
  const name = unique()
  containers.push(name)
  return name
}

/** The value of `CHAD_OPENAI_API_URL` that reaches the fake model server of a second container by its name. */
export const modelUrl = (second: string) => `http://${second}:${modelPort}/v1`

// The fakes listen at a unix socket on the volume and the test runs on the host, so the test-only requests go through
// the engine's own `exec`: these lines of Node, in the second container, join their standard streams to the socket.
// It needs no published port, which an internal network has none of, and is the same command on Docker and podman.
const relay =
  'const socket = require("node:net").connect(process.argv[1]); process.stdin.pipe(socket).pipe(process.stdout)'
const socket = "/data/run/local.sock"

/** The two pipes of a child process as one stream. Destroying it ends the child. */
const piped = (child: ChildProcessByStdio<Writable, Readable, null>) => {
  const stream = new Duplex({
    read: () => void child.stdout.resume(),
    write: (chunk, encoding, done) =>
      void child.stdin.write(chunk, encoding, done),
    final: (done) => void child.stdin.end(done),
    destroy: (error, done) => {
      child.kill()
      done(error)
    },
  })
  child.stdout.on("data", (chunk) => {
    if (!stream.push(chunk)) child.stdout.pause()
  })
  child.stdout.on("end", () => stream.push(null))
  // The pipe may close under a write once the child is gone.
  child.stdin.on("error", () => {})
  return stream
}

/**
 * Starts the second container of layer 5 under a reserved name: the image, with its default uid, on the daemon's
 * network and volume, running the bundled file in place of the entrypoint. It waits until the local platform listens
 * at `run/local.sock`, which needs the `run/` the daemon made, and gives the fakes over the test-only requests.
 */
export const fakes = async (
  name: string,
  network: string,
  data: string,
): Promise<Fakes.Fakes> => {
  const file = await bundleFakes()
  succeed([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    "--volume",
    data + ":/data",
    "--volume",
    `${file}:${fakesFile}:ro`,
    "--entrypoint",
    "node",
    image,
    fakesFile,
    String(modelPort),
  ])
  await printed(name, '"kind":"listening"', "the fakes were not listening")
  return Fakes.over(
    Layer.effect(
      Socket.Socket,
      NodeSocket.fromDuplex(
        Effect.acquireRelease(
          Effect.sync(() =>
            piped(
              spawn(
                engine,
                ["exec", "--interactive", name, "node", "-e", relay, socket],
                { stdio: ["pipe", "pipe", "inherit"] },
              ),
            ),
          ),
          (stream) => Effect.sync(() => stream.destroy()),
        ),
      ),
    ),
    scope,
  )
}

/**
 * Runs the part of a scenario that drives its two containers, under one deadline, and gives the scenario's directory
 * under the run id. It keeps there what the two containers wrote, with the daemon's log and the database from the
 * volume, as a scenario of layers 3 and 4 keeps them. The second container writes its event log to standard output,
 * so what it wrote is that log. When the scenario fails, the error says how far it came and carries what the
 * containers wrote.
 */
export const scenario = async (
  pair: { readonly daemon: string; readonly fakes: string },
  body: (step: (doing: string) => void) => Promise<void>,
): Promise<string> => {
  const directory = fresh()
  const keep = () => {
    mkdirSync(join(directory, "data"), { recursive: true })
    // `secrets/` stays on the volume.
    for (const kept of ["logs", "db"]) {
      run("cp", `${pair.daemon}:/data/${kept}`, join(directory, "data", kept))
    }
    return Object.entries(pair).map(([role, name]) => {
      const { stdout, stderr } = logs(name)
      writeFileSync(join(directory, role + ".log"), stdout + stderr)
      return `--- the container of the ${role} wrote\n${stdout}${stderr}`
    })
  }
  let doing = "starting"
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      body((next) => (doing = next)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("it did not end in 90 seconds")),
          90_000,
        )
      }),
    ])
  } catch (cause) {
    throw new Error(
      [
        `the scenario failed while ${doing}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ...keep(),
        `--- kept in ${directory}`,
      ].join("\n"),
      { cause },
    )
  } finally {
    clearTimeout(timer)
  }
  keep()
  return directory
}

/** Removes every container, volume and network the tests made. The image stays, for the layer cache. */
export const cleanup = async (): Promise<void> => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  if (containers.length > 0) run("rm", "--force", ...containers)
  if (volumes.length > 0) run("volume", "rm", "--force", ...volumes)
  if (networks.length > 0) run("network", "rm", ...networks)
  if (bundleDirectory !== undefined) {
    rmSync(bundleDirectory, { recursive: true, force: true })
  }
}
