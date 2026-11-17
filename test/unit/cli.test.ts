import { ExitCode } from "../../src/cli/Failure.ts"
import * as Messages from "../../src/Messages.ts"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { Deferred, Duration, Effect, Exit, Layer, Schema, Scope } from "effect"
import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/rpc"
import { expect, it, onTestFinished } from "vitest"
import * as Daemon from "../../src/cli/Daemon.ts"
import { Environment } from "../../src/cli/Environment.ts"
import * as Filesystem from "../../src/daemon/Filesystem.ts"
import * as Logger from "../../src/daemon/Logger.ts"
import * as Server from "../../src/daemon/Server.ts"
import * as Lock from "../../src/Lock.ts"
import { OpenRpcs, layerVersionCheck } from "../../src/Rpcs.ts"
import { Timings, defaults } from "../../src/Timings.ts"
import { version } from "../../src/Version.ts"

const temporary = () => mkdtempSync(join(tmpdir(), "chad-cli-"))

/**
 * A second process that takes the daemon lock as chad does, with an exclusive SQLite transaction, and says so. It
 * holds the lock until it is killed, or for the given time when one is given.
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

it("a daemon that starts while another process holds the lock for a moment waits for it and takes the lock, and one that finds it held past the busy timeout does not", async () => {
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

it("the filesystem check follows the data directory to the mount that really holds it, by the longest mount point above it", () => {
  // The data path is a link to a directory on the NFS mount, whose mount point the kernel writes with an escape.
  const linked = warned("ext4", {}, "/srv/chad", (path) =>
    path === "/srv/chad" ? "/with space/chad" : path,
  )
  expect(linked).toEqual([Messages.filesystemNetwork("/srv/chad", "nfs4")])
  // A path that only starts with the name of a mount point is not under it.
  expect(warned("nfs", {}, "/data2")).toEqual([])
  expect(warned("nfs", {}, "/data/deep/down")).toHaveLength(1)
})

it("a command waits for the daemon's first answer no longer than the CLI's wait, and once the daemon has answered it waits on its call with no deadline of its own", async () => {
  const data = temporary()
  mkdirSync(join(data, "run"))
  mkdirSync(join(data, "state"))
  const environment = {
    data,
    socket: join(data, "run/chad.sock"),
    lock: join(data, "state/daemon.lock"),
    session: undefined,
    inherited: {},
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

it("the RPC server interrupts a call whose client went away and the daemon writes rpc.cancelled at debug level, with the call's name and nothing of its payload", async () => {
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
