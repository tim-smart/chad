import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { Deferred, Duration, Effect, Exit, Layer, Schema, Scope } from "effect"
import { Command } from "effect/cli"
import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcSerialization,
  RpcServer,
  RpcTest,
} from "effect/rpc"
import { expect, it, onTestFinished } from "vitest"
import * as Daemon from "../../src/cli/Daemon.ts"
import { Environment } from "../../src/cli/Environment.ts"
import { ExitCode } from "../../src/cli/Failure.ts"
import * as Flags from "../../src/cli/Flags.ts"
import type { CliInputs } from "../../src/cli/runCli.ts"
import * as Filesystem from "../../src/daemon/Filesystem.ts"
import * as Logger from "../../src/daemon/Logger.ts"
import * as Server from "../../src/daemon/Server.ts"
import * as Lock from "../../src/Lock.ts"
import * as Messages from "../../src/Messages.ts"
import * as Paths from "../../src/Paths.ts"
import {
  OpenRpcs,
  Refused,
  VersionCheck,
  layerVersionCheck,
  versionHeader,
} from "../../src/Rpcs.ts"
import * as Status from "../../src/Status.ts"
import { Timings, defaults } from "../../src/Timings.ts"
import { version } from "../../src/Version.ts"
import { json, read } from "../support/repo.ts"

const temporary = () => mkdtempSync(join(tmpdir(), "chad-cli-"))

/**
 * A second process that takes the daemon lock the way 10-cli.md writes it and says so. It holds the lock until it is
 * killed, or for the given time when one is given.
 */
const holder = (path: string, milliseconds?: number) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite")
       const lock = new DatabaseSync(process.argv[1], { timeout: 3000 })
       lock.exec("PRAGMA journal_mode=MEMORY; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;")
       console.log("held")
       const hold = Number(process.argv[2])
       if (hold > 0) setTimeout(() => lock.close(), hold)
       else setInterval(() => {}, 1000)`,
      path,
      String(milliseconds ?? 0),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  )
  // A test that fails before it lets the holder go would leave it running, and the run would wait on it.
  onTestFinished(() => void child.kill("SIGKILL"))
  return {
    child,
    held: new Promise<void>((resolve) => child.stdout.once("data", resolve)),
    gone: new Promise<void>((resolve) => child.once("exit", () => resolve())),
  }
}

it("CLI-28 STO-27 the CLI's lock test reads a missing lock file as free and creates nothing, reads a held lock as held in under 4 ms, and no journal file appears beside the lock", async () => {
  const directory = temporary()
  const path = join(directory, "daemon.lock")
  try {
    expect(Lock.test(path)).toBe("free")
    expect(readdirSync(directory)).toEqual([])

    const other = holder(path)
    await other.held
    const took: Array<number> = []
    for (let run = 0; run < 20; run++) {
      const before = performance.now()
      expect(Lock.test(path)).toBe("held")
      took.push(performance.now() - before)
    }
    expect(Math.min(...took)).toBeLessThan(4)
    expect(readdirSync(directory)).toEqual(["daemon.lock"])

    other.child.kill("SIGKILL")
    await other.gone
    expect(Lock.test(path)).toBe("free")
    expect(readdirSync(directory)).toEqual(["daemon.lock"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("CLI-26 a daemon that starts while another process holds the lock for a moment waits for it and takes the lock, and one that finds it held past the busy timeout does not", async () => {
  const directory = temporary()
  const path = join(directory, "daemon.lock")
  try {
    const other = holder(path)
    await other.held
    expect(Lock.take(path, Duration.millis(50))).toBeUndefined()
    other.child.kill("SIGKILL")
    await other.gone

    // This holder lets go a second after it says it holds the lock, while this process is inside the busy wait.
    const brief = holder(path, 1000)
    await brief.held
    const release = Lock.take(path, Duration.seconds(3))
    expect(release).toBeTypeOf("function")
    expect(Lock.test(path)).toBe("held")
    release?.()
    expect(Lock.test(path)).toBe("free")
    expect(readdirSync(directory)).toEqual(["daemon.lock"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

const mountinfo = [
  "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
  "30 22 0:26 / /data rw,relatime shared:2 - TYPE source rw",
  "31 22 0:27 / /dev/shm rw,nosuid shared:3 - tmpfs tmpfs rw",
  "32 22 0:28 / /layer rw,relatime shared:4 - overlay overlay rw",
  "33 22 8:2 / /with\\040space rw,relatime shared:5 - nfs4 server:/x rw",
].join("\n")

const warned = (
  type: string,
  env: Readonly<Record<string, string | undefined>> = {},
  data = "/data",
  real: (path: string) => string = (path) => path,
) =>
  Filesystem.warnings({
    mountinfo: mountinfo.replace("TYPE", type),
    data,
    env,
    real,
  })

it("IMG-70 the filesystem check warns for NFS, CephFS, SMB, FUSE, the container's own layer and tmpfs, and for nothing else", () => {
  const network = (type: string) =>
    `/data is on ${type}. chad needs a local filesystem: SQLite's lock and write-ahead log are not safe on a network or FUSE filesystem.`
  for (const type of ["nfs", "nfs4", "ceph", "cifs", "smb3", "fuse.sshfs"]) {
    expect(warned(type)).toEqual([network(type)])
  }
  expect(warned("overlay")).toEqual([
    "/data is on the container's own filesystem, not on a volume. Everything chad writes is lost when the container is removed. Mount a volume at /data.",
  ])
  expect(warned("tmpfs")).toEqual([
    "/data is on tmpfs, which is memory. Everything chad writes is lost when the container stops.",
  ])
  for (const type of ["ext4", "xfs", "btrfs", "zfs"]) {
    expect(warned(type)).toEqual([])
  }
})

it("IMG-71 the filesystem check follows the data directory to the mount that really holds it, by the longest mount point above it", () => {
  // The data path is a link to a directory on the NFS mount, whose mount point the kernel writes with an escape.
  const linked = warned("ext4", {}, "/srv/chad", (path) =>
    path === "/srv/chad" ? "/with space/chad" : path,
  )
  expect(linked).toEqual([Messages.filesystemNetwork("/srv/chad", "nfs4")])
  // A path that only starts with the name of a mount point is not under it.
  expect(warned("nfs", {}, "/data2")).toEqual([])
  expect(warned("nfs", {}, "/data/deep/down")).toHaveLength(1)
})

it("IMG-72 the filesystem check warns for each of HOME, NPM_CONFIG_PREFIX and XDG_CACHE_HOME that is on the container's own layer or on tmpfs", () => {
  expect(
    warned("ext4", {
      HOME: "/layer/home",
      NPM_CONFIG_PREFIX: "/data/home/.npm-global",
      XDG_CACHE_HOME: "/dev/shm/cache",
    }),
  ).toEqual([
    "HOME=/layer/home is on the container's own filesystem, not on the volume at /data. What is installed there is lost with the container. In the chad image the volume is mounted at /data.",
    "XDG_CACHE_HOME=/dev/shm/cache is on tmpfs, not on the volume at /data. What is installed there is lost with the container. In the chad image the volume is mounted at /data.",
  ])
  // A network filesystem under one of the three is the data directory's warning to give, not theirs.
  expect(warned("nfs", { HOME: "/data/home" })).toHaveLength(1)
})

it("IMG-63 CLI-11 CLI-213 the socket path limit is the platform's, 107 bytes on Linux and 103 on macOS, and a listen that fails for any reason but an address in use or a refused permission names the filesystem as unsupported", () => {
  expect(Paths.socketLimit("linux")).toBe(107)
  expect(Paths.socketLimit("darwin")).toBe(103)
  expect(Paths.socketTooLong("/" + "a".repeat(106), "linux")).toBeUndefined()
  expect(Paths.socketTooLong("/" + "a".repeat(106), "darwin")).toEqual({
    bytes: 107,
    limit: 103,
  })
  // The limit is in bytes, and this path is 106 characters long.
  expect(Paths.socketTooLong("/" + "é".repeat(105), "linux")).toEqual({
    bytes: 211,
    limit: 107,
  })

  const volume = { data: "/data", socket: "/data/run/chad.sock" }
  expect(Server.listenFailure(volume, "EOPNOTSUPP", () => "nfs4")).toBe(
    "chad serve: cannot create the socket /data/run/chad.sock (EOPNOTSUPP). /data/run is on nfs4, which cannot hold a unix socket. chad needs a local filesystem under /data.",
  )
  for (const code of ["EADDRINUSE", "EACCES"]) {
    expect(Server.listenFailure(volume, code, () => "nfs4")).toBe(
      `chad serve: cannot create the socket /data/run/chad.sock (${code}).`,
    )
  }
})

const Probe = RpcGroup.make(
  Rpc.make("Probe", { success: Schema.String }),
).middleware(VersionCheck)

const probe = (headers: Record<string, string>, daemon?: string) =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(Probe)
    return yield* client.Probe().pipe(RpcClient.withHeaders(headers))
  }).pipe(
    Effect.provide(Probe.toLayer({ Probe: () => Effect.succeed("ran") })),
    Effect.provide(layerVersionCheck(daemon)),
    Effect.scoped,
    // What the call gave: its answer, or the refusal.
    Effect.catch((refused) => Effect.succeed({ ...refused })),
    Effect.runPromise,
  )

it("CLI-21 IMG-97 a call that the version check covers runs for a CLI of the daemon's exact version and is refused for any other version or none, and the CLI's headers carry its version", async () => {
  expect(Daemon.headers()).toEqual({
    "chad-version": json("package.json").version,
  })
  expect(versionHeader).toBe("chad-version")

  expect(await probe(Daemon.headers())).toBe("ran")
  expect(await probe({ [versionHeader]: "1.2.3" }, "1.2.3")).toBe("ran")
  // The compare is exact, so a build suffix and a prefix both differ.
  for (const cli of ["1.2.30", "1.2", "v1.2.3", "1.2.3-rc.1"]) {
    expect(await probe({ [versionHeader]: cli }, "1.2.3")).toMatchObject({
      _tag: "Refused",
      cli,
      daemon: "1.2.3",
    })
  }
  expect(await probe({}, "1.2.3")).toMatchObject({
    _tag: "Refused",
    cli: null,
    daemon: "1.2.3",
  })
})

it("CLI-22 CLI-155 CLI-214 a command the daemon refused for its version fails with exit code 1 and tells the owner to run it with docker exec", () => {
  const failure = Daemon.refused(
    "connection list",
    new Refused({ cli: "1.0.0", daemon: "1.1.0" }),
  )
  expect(failure.code).toBe(1)
  expect(failure.message).toBe(
    "chad connection list: refused: this CLI is chad 1.0.0 and the daemon is chad 1.1.0. Run the command with the daemon's own CLI, for example: docker exec -it chad chad connection list",
  )
})

it("CLI-42a a command waits for the daemon's first answer no longer than the CLI's wait, and once the daemon has answered it waits on its call with no deadline of its own", async () => {
  const data = temporary()
  mkdirSync(join(data, "run"))
  mkdirSync(join(data, "state"))
  const environment = {
    data,
    socket: join(data, "run/chad.sock"),
    lock: join(data, "state/daemon.lock"),
    session: undefined,
  }
  const release = Lock.take(environment.lock, Duration.zero)
  const wait = Duration.millis(100)
  const slow = Effect.sleep(Duration.times(wait, 4))
  /** A daemon whose ping or whose status takes four times the CLI's wait, and the command that reaches it. */
  const command = (late: "Ping" | "Status") =>
    Effect.gen(function* () {
      yield* Layer.build(
        RpcServer.layer(OpenRpcs).pipe(
          Layer.provide(
            OpenRpcs.toLayer({
              Ping: () =>
                Effect.as(late === "Ping" ? slow : Effect.void, "pong"),
              Status: () =>
                Effect.as(late === "Status" ? slow : Effect.void, {
                  version,
                  effect: "4",
                  phase: "ready" as const,
                  filesystem: [],
                  connections: [],
                }),
            }),
          ),
          Layer.provide(layerVersionCheck()),
          Layer.provide(RpcServer.layerProtocolSocketServer),
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(NodeSocketServer.layer({ path: environment.socket })),
        ),
      )
      const client = yield* Daemon.reach("probe")
      return (yield* client.Status()).phase
    }).pipe(
      Effect.scoped,
      Effect.provideService(Environment, environment),
      Effect.provideService(Timings, { ...defaults, cliAnswer: wait }),
      Effect.catchTag("Failure", (failure) => Effect.succeed(failure.code)),
      Effect.runPromise,
    )
  try {
    expect(await command("Status")).toBe("ready")
    rmSync(environment.socket, { force: true })
    expect(await command("Ping")).toBe(ExitCode.daemon)
  } finally {
    release?.()
    rmSync(data, { recursive: true, force: true })
  }
})

it("CLI-16 CLI-17 CLI-20a FAIL-10 FAIL-304 the RPC server interrupts a call whose client went away and the daemon writes rpc.cancelled at debug level, with the call's name and nothing of its payload", async () => {
  const directory = temporary()
  const path = join(directory, "chad.sock")
  const Calls = RpcGroup.make(
    Rpc.make("Wait", { payload: { word: Schema.String } }),
  )
  const lines: Array<string> = []
  try {
    const interrupted = await Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const scope = yield* Effect.scope
      yield* Layer.buildWithScope(
        Server.serve(Calls, { phase: "ready" }).pipe(
          Layer.provide(
            Calls.toLayer({
              Wait: () =>
                Deferred.succeed(running, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(interrupted, undefined),
                  ),
                ),
            }),
          ),
          Layer.provide(NodeSocketServer.layer({ path })),
        ),
        scope,
      )

      // The client has a scope of its own, and closing it is the client going away.
      const client = yield* Scope.make()
      const protocol = yield* Layer.buildWithScope(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(NodeSocket.layerNet({ path })),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        client,
      )
      const calls = yield* RpcClient.make(Calls).pipe(
        Effect.provideContext(protocol),
        Scope.provide(client),
      )
      yield* Effect.forkIn(calls.Wait({ word: "open-sesame" }), client)
      yield* Deferred.await(running)
      // Nothing is sent that asks for the interrupt: the socket is destroyed, as it is for a killed CLI.
      yield* Scope.close(client, Exit.void)
      yield* Deferred.await(interrupted)
      // The line is written by the interrupted call's own fiber, so it is there once the server has closed.
      return true
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Logger.layer({
          level: "All",
          file: Logger.makeFileSink(),
          stdout: (line) => lines.push(line),
        }),
      ),
      Effect.runPromise,
    )
    expect(interrupted).toBe(true)
    const cancelled = lines.filter((line) =>
      line.includes("event=rpc.cancelled"),
    )
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]).toMatch(/level=DEBUG .*call=Wait/)
    expect(lines.join("\n")).not.toContain("open-sesame")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("CLI-51a the client's exit codes are the codes of the table in 10-cli.md that are not chad secret run's own", () => {
  const rows = read("docs/spec/10-cli.md")
    .split("\n")
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => !cells[2]?.startsWith("`chad secret run`"))
    .map((cells) => Number(cells[1]))
  expect(rows).toEqual([0, 1, 2, 3, 4, 130])
  expect(Object.values(ExitCode).sort((a, b) => a - b)).toEqual(rows)
})

it("CLI-50 a boolean flag is declared with a default, so a command line without it parses and the flag reads false", async () => {
  const seen: Array<boolean> = []
  const command = Command.make(
    "probe",
    { loud: Flags.boolean("loud") },
    (flags) => Effect.sync(() => seen.push(flags.loud)),
  )
  const run = (args: ReadonlyArray<string>) =>
    Command.runWith(command, { version: "0" })(args).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    )
  await run([])
  await run(["--loud"])
  expect(seen).toEqual([false, true])
})

it("CLI-215 SELF-8 IMG-128 chad status prints one fact to a line: the daemon and its phase, chad's version and effect's, each filesystem warning and each connection, and what the files say when no daemon answers", () => {
  expect(
    Status.render({
      daemon: "up",
      report: {
        version: "1.2.3",
        effect: "4.1.4",
        phase: "loading",
        filesystem: ["/data is on tmpfs, which is memory."],
        connections: [
          { name: "discord", kind: "discord" },
          { name: "test", kind: "local" },
        ],
      },
    }),
  ).toBe(
    [
      "daemon: up (loading)",
      "version: chad 1.2.3, effect 4.1.4",
      "filesystem: /data is on tmpfs, which is memory.",
      "connection: discord (discord)",
      "connection: test (local)",
    ].join("\n"),
  )
  expect(
    Status.render({
      daemon: "none",
      lock: "/data/state/daemon.lock",
      version: "1.2.3",
      volume: undefined,
    }),
  ).toBe(
    [
      "daemon: not running (lock /data/state/daemon.lock is free)",
      "version: chad 1.2.3, volume not written yet",
    ].join("\n"),
  )
  expect(
    Status.render({
      daemon: "silent",
      socket: "/data/run/chad.sock",
      seconds: 2,
      version: "1.2.3",
      volume: "1.2.2",
    }),
  ).toBe(
    [
      "daemon: starting or frozen (lock held, no answer on /data/run/chad.sock in 2s)",
      "version: chad 1.2.3, volume written by chad 1.2.2",
    ].join("\n"),
  )
})

it("TST-90 TST-92 CLI-153 CLI-212 the CLI's messages are templates of the Messages module, in the spec's wording", () => {
  const spec =
    read("docs/spec/10-cli.md") + read("docs/spec/01-image-and-volume.md")
  expect(Messages.noDaemon("apply", "<volume>/state/daemon.lock")).toBe(
    "chad apply: no daemon (lock <volume>/state/daemon.lock is free)",
  )
  expect(Messages.daemonSilent("apply", "<socket>", 2)).toBe(
    "chad apply: daemon is starting or frozen (lock held, no answer on <socket> in 2s)",
  )
  expect(Messages.healthy()).toBe("chad health: ok")
  const templates = [
    Messages.noDaemon("apply", "<volume>/state/daemon.lock"),
    Messages.daemonSilent("apply", "<socket>", 2),
    Messages.healthy(),
    Messages.lockHeld("/data"),
    Messages.socketPathTooLong("<path>", 120, 107)
      .replace("120 bytes", "<n> bytes")
      .replace("holds 107", "holds <limit>"),
    Messages.socketUnsupported(
      "<path>",
      "<error code>",
      "<directory>",
      "<filesystem type>",
      "/data",
    ),
    Messages.socketFailed("<path>", "<error code>"),
    Messages.filesystemNetwork("/data", "<type>"),
    Messages.filesystemContainer("/data"),
    Messages.filesystemMemory("/data", "<tmpfs or ramfs>"),
    Messages.filesystemInstall(
      "<NAME>",
      "<value>",
      "<the container's own filesystem, or tmpfs>",
      "/data",
    ),
    Messages.versionMismatch("<command>", "<cli>", "<daemon>"),
  ]
  for (const template of templates) expect(spec).toContain(template)
})

it("TST-209 runCli takes the words of the command line, an HttpClient and the durations, and no other input, and the bundle's entry hands it the real ones", () => {
  // The type-check fails on a key that is missing here or that CliInputs does not have.
  const inputs: Record<keyof CliInputs, true> = {
    args: true,
    httpClient: true,
    timings: true,
  }
  const entry = read("src/cli.ts")
  for (const name of Object.keys(inputs)) {
    expect(entry).toMatch(new RegExp(`^  ${name}: `, "m"))
  }
  expect(entry).toContain("timings: defaults")
  expect(entry).toContain("process.exitCode = await runCli(")
  const code = entry
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("//"))
  expect(code.length).toBeLessThanOrEqual(15)
})
