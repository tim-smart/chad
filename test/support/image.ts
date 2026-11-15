// What the image layer of docs/spec/17-testing.md shares: one build of the Dockerfile, and containers and volumes
// that are removed when the tests end.
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { root } from "./repo.ts"

/** The container engine. podman works where it answers to the same commands. */
export const engine = process.env["CHAD_ENGINE"] ?? "docker"

/** The image under test, and its build stage, which holds the vendored tarballs and the build's own steps. */
export const image = "chad-test:image"
export const buildStage = "chad-test:build"

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

/** Builds the image and tags its build stage, once however often it is asked. The second build is all cache. */
export const buildImage = (): Promise<void> =>
  (built ??= build(image).then(() => build(buildStage, "--target", "build")))

export interface Healthcheck {
  readonly Test: ReadonlyArray<string>
  readonly Interval: number
  readonly Timeout: number
  readonly StartPeriod: number
  readonly StartInterval: number
  readonly Retries: number
}

export interface Config {
  readonly User?: string
  readonly Env?: ReadonlyArray<string>
  readonly Entrypoint?: ReadonlyArray<string>
  readonly Cmd?: ReadonlyArray<string>
  readonly WorkingDir?: string
  readonly ExposedPorts?: Record<string, unknown> | null
  readonly Volumes?: Record<string, unknown> | null
  readonly StopSignal?: string
  readonly Healthcheck?: Healthcheck
}

/** The built image's configuration. podman reports the health check beside the configuration and Docker inside it. */
export const inspect = (): Config => {
  const [about] = JSON.parse(succeed(["image", "inspect", image]))
  return { Healthcheck: about.Healthcheck, ...about.Config }
}

const containers: Array<string> = []
const volumes: Array<string> = []
const unique = () => `chad-test-${randomBytes(4).toString("hex")}`

/** Creates an empty named volume. */
export const volume = (): string => {
  const name = unique()
  succeed(["volume", "create", name])
  volumes.push(name)
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

/**
 * Waits for the daemon's `boot.ready` line on the container's standard output. It never waits for a healthy
 * container.
 */
export const ready = async (container: string): Promise<void> => {
  const deadline = Date.now() + 60_000
  for (;;) {
    if (logs(container).stdout.includes("event=boot.ready")) return
    const running = run(
      "inspect",
      "--format",
      "{{.State.Running}}",
      container,
    ).stdout.trim()
    if (running !== "true" || Date.now() > deadline) {
      const { stdout, stderr } = logs(container)
      throw new Error(`chad serve was not ready\n${stdout}${stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
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

/** Removes every container and volume the tests made. The image stays, for the layer cache. */
export const cleanup = (): void => {
  if (containers.length > 0) run("rm", "--force", ...containers)
  if (volumes.length > 0) run("volume", "rm", "--force", ...volumes)
}
