import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Effect, Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { expect, onTestFinished, test, vi } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { Rpcs } from "../../dist/Rpcs.js"
import { version } from "../../dist/Version.js"
import { fresh, scenario } from "../support/driver.ts"
import { json, read } from "../support/repo.ts"

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

/** What the daemon wrote to stdout, one entry for each line. */
const stdout = () => {
  const spy = vi.spyOn(process.stdout, "write")
  return () =>
    spy.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.startsWith("timestamp="))
}

/** The lines of a `chad status`, without the warnings about the filesystem the suite happens to run on. */
const facts = (stdout: string) =>
  stdout.split("\n").filter((line) => !line.startsWith("filesystem: "))

const events = (lines: ReadonlyArray<string>) =>
  lines.map((line) => / event=(\S+)/.exec(line)?.[1])

test("OV-19 CLI-8 IMG-74 CLI-125a CLI-125h CLI-125i SELF-8 IMG-17 CLI-55 FAIL-286a FAIL-287 chad health and chad status reach the running daemon over the socket at run/chad.sock, as the owner's shell does", async () => {
  const running = await scenario()
  const { data } = running
  const ready = await running.logged("boot.ready")
  expect(statSync(join(data, "run/chad.sock")).isSocket()).toBe(true)

  // The daemon's own process carries the marker, and the owner's shell and the image do not.
  expect(process.env["CHAD_SESSION"]).toBe("daemon")
  expect(running.environment()["CHAD_SESSION"]).toBeUndefined()
  expect(read("Dockerfile")).not.toContain("CHAD_SESSION")

  expect(await running.chad(["health"])).toEqual({
    stdout: "chad health: ok\n",
    stderr: "",
    code: 0,
  })
  const status = await running.chad(["status"])
  expect(status.code).toBe(0)
  expect(status.stderr).toBe("")
  expect(facts(status.stdout)).toEqual([
    "daemon: up (ready)",
    `version: chad ${json("package.json").version}, effect ${json("node_modules/effect/package.json").version}`,
    "connection: local (local)",
    "",
  ])

  const started = await running.logged("boot.started")
  expect(started.annotations).toMatchObject({
    version,
    node: process.version,
    data,
  })
  expect(ready.annotations["duration_ms"]).toBeTypeOf("number")
  expect(ready.annotations["connections"]).toBe(1)
})

test("STO-4 IMG-35 CLI-10 run/ gets mode 0700 on a start that finds it wider, the socket gets 0600 after the listen, and the umask is left alone", async () => {
  const directory = fresh()
  mkdirSync(join(directory, "data/run"), { recursive: true, mode: 0o755 })
  expect(mode(join(directory, "data/run"))).toBe("755")
  const umask = process.umask()

  const running = await scenario({ directory })
  await running.logged("boot.ready")
  expect(mode(join(running.data, "run"))).toBe("700")
  expect(mode(join(running.data, "run/chad.sock"))).toBe("600")
  expect(process.umask()).toBe(umask)
})

test("IMG-62 IMG-128 IMG-141 CLI-14a STO-43 chad status answers while the boot is still loading and names the phase, and chad health passes", async () => {
  let loaded = () => {}
  const running = await scenario({
    loading: new Promise((resolve) => (loaded = resolve)),
  })
  // The database is open and migrated by now, and no connection has loaded.
  await running.logged("database.migrated")
  const during = await running.chad(["status"])
  expect(during.code).toBe(0)
  expect(facts(during.stdout)[0]).toBe("daemon: up (loading)")
  expect((await running.chad(["health"])).code).toBe(0)
  expect(
    running.log().some((line) => line.annotations["event"] === "boot.ready"),
  ).toBe(false)

  loaded()
  await running.logged("boot.ready")
  expect(facts((await running.chad(["status"])).stdout)[0]).toBe(
    "daemon: up (ready)",
  )
})

test("OV-20 IMG-59 IMG-60 IMG-126 CLI-13 CLI-25 STO-26 STO-196 FAIL-286a FAIL-322 a second daemon on the volume is refused the lock: it exits 1, says so on stdout only, and touches no socket, log file or directory", async () => {
  const printed = stdout()
  const first = await scenario()
  const { data } = first
  await first.logged("boot.ready")
  const before = {
    files: readdirSync(data, { recursive: true }).sort(),
    log: readFileSync(join(data, "logs/chad.log"), "utf8"),
    socket: statSync(join(data, "run/chad.sock")).ino,
    lines: printed().length,
  }

  const second = await scenario({ directory: first.directory })
  expect(await second.exit).toBe(1)
  const lines = printed().slice(before.lines)
  expect(events(lines)).toEqual(["boot.refused"])
  expect(lines[0]).toContain("reason=lock")
  expect(lines[0]).toContain(
    `chad serve: another chad serve holds the lock on ${data}. This boot is not counted.`,
  )

  expect(readdirSync(data, { recursive: true }).sort()).toEqual(before.files)
  expect(readFileSync(join(data, "logs/chad.log"), "utf8")).toBe(before.log)
  expect(statSync(join(data, "run/chad.sock")).ino).toBe(before.socket)
  // No journal file was ever written beside the lock.
  expect(readdirSync(join(data, "state")).sort()).toEqual([
    "daemon.lock",
    "version",
  ])
  expect((await first.chad(["health"])).code).toBe(0)
})

test("CLI-13 CLI-14a IMG-62 IMG-142 a boot that the shard count guard refuses had already removed the socket file a killed daemon left and listened, and its boot.refused line is in the log file", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(join(data, "db"), { recursive: true })
  mkdirSync(join(data, "run"))
  writeFileSync(join(data, "run/chad.sock"), "left by a killed daemon")
  const database = new DatabaseSync(join(data, "db/chad.db"))
  database.exec(
    "CREATE TABLE chad_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO chad_meta VALUES ('shards', '2')",
  )
  database.close()

  const running = await scenario({ directory })
  expect(await running.exit).toBe(1)
  const refused = await running.logged("boot.refused")
  expect(refused.annotations["reason"]).toBe("shards")
  // The file the test left is gone, and the daemon's own socket went with the daemon.
  expect(existsSync(join(data, "run/chad.sock"))).toBe(false)
})

test("IMG-70 IMG-71 IMG-72 IMG-126 FAIL-290 FAIL-322 a volume that is really on tmpfs is warned about on stdout before the lock, in the log file once the lock is held and in chad status, and the boot goes on", async () => {
  // The data path is a link from the scenario's directory to a directory on tmpfs, so the check has to follow it.
  const memory = mkdtempSync("/dev/shm/chad-")
  onTestFinished(() => rmSync(memory, { recursive: true, force: true }))
  const directory = fresh()
  mkdirSync(directory, { recursive: true })
  mkdirSync(join(memory, "data"))
  mkdirSync(join(memory, "cache"))
  symlinkSync(join(memory, "data"), join(directory, "data"))
  const cache = join(memory, "cache")
  const printed = stdout()

  const running = await scenario({
    directory,
    env: { XDG_CACHE_HOME: cache },
  })
  const { data } = running
  await running.logged("boot.ready")
  const warnings = [
    `${data} is on tmpfs, which is memory. Everything chad writes is lost when the container stops.`,
    `XDG_CACHE_HOME=${cache} is on tmpfs, not on the volume at ${data}. What is installed there is lost with the container. In the chad image the volume is mounted at /data.`,
  ]

  const file = running
    .log()
    .filter((line) =>
      ["boot.filesystem", "boot.started"].includes(
        String(line.annotations["event"]),
      ),
    )
  // The file has the warnings in the order stdout has them, ahead of the line that says the lock is held.
  expect(file.map((line) => line.annotations["event"])).toEqual([
    ...warnings.map(() => "boot.filesystem"),
    "boot.started",
  ])
  expect(file.map((line) => line.message).slice(0, -1)).toEqual(
    expect.arrayContaining(warnings),
  )
  expect(file.slice(0, -1).every((line) => line.level === "WARN")).toBe(true)
  const shown = events(printed()).filter(
    (event) => event === "boot.filesystem" || event === "boot.started",
  )
  expect(shown).toEqual(file.map((line) => line.annotations["event"]))

  const status = await running.chad(["status"])
  expect(status.code).toBe(0)
  for (const warning of warnings) {
    expect(status.stdout).toContain(`filesystem: ${warning}\n`)
  }
})

test("CLI-9 CLI-12 IMG-30 CHAD_SOCKET moves the socket for the daemon and for the CLI, and a CLI whose connect fails with EINVAL prints the daemon's path-length message", async () => {
  const directory = fresh()
  mkdirSync(directory, { recursive: true })
  const socket = join(directory, "moved.sock")
  const running = await scenario({ directory, env: { CHAD_SOCKET: socket } })
  await running.logged("boot.ready")

  expect(statSync(socket).isSocket()).toBe(true)
  expect(existsSync(join(running.data, "run/chad.sock"))).toBe(false)
  expect((await running.chad(["health"], { CHAD_SOCKET: socket })).code).toBe(0)
  // Without the variable the CLI looks on the volume, where nothing listens.
  expect((await running.chad(["health"])).code).toBe(4)

  const long = join(directory, "s".repeat(120))
  expect(await running.chad(["health"], { CHAD_SOCKET: long })).toEqual({
    stdout: "",
    stderr:
      Messages.socketPathTooLong(long, Buffer.byteLength(long), 107) + "\n",
    code: 4,
  })
})

test("IMG-63 CLI-11 a socket path over the platform's limit ends the start with exit 1 and a line that gives the length, the limit and CHAD_SOCKET as the fix, and nothing is created at the path", async () => {
  const directory = fresh()
  mkdirSync(directory, { recursive: true })
  const socket = join(directory, "s".repeat(120))
  const bytes = Buffer.byteLength(socket)
  const running = await scenario({ directory, env: { CHAD_SOCKET: socket } })

  expect(await running.exit).toBe(1)
  // The boot holds the lock by then, so the line is in the file as well.
  const refused = await running.logged("boot.refused")
  expect(refused.message).toBe(
    `chad serve: the socket path ${socket} is ${bytes} bytes and a unix socket path holds 107. Set CHAD_SOCKET to a shorter path, for example /tmp/chad.sock.`,
  )
  expect(refused.annotations["reason"]).toBe("socket")
  expect(existsSync(socket)).toBe(false)
})

test("CLI-22 IMG-97 the calls behind chad health and chad status are answered for a CLI of another chad version", async () => {
  const running = await scenario()
  await running.logged("boot.ready")
  const answers = await Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          NodeSocket.layerNet({ path: join(running.data, "run/chad.sock") }),
        ),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    )
    const client = yield* RpcClient.make(Rpcs).pipe(
      Effect.provideContext(protocol),
    )
    return {
      ping: yield* client.Ping(),
      daemon: (yield* client.Status()).version,
    }
  }).pipe(
    RpcClient.withHeaders({ "chad-version": version + "-other" }),
    Effect.scoped,
    Effect.runPromise,
  )
  expect(answers).toEqual({ ping: "pong", daemon: version })
})

test("CLI-23a CLI-125i CLI-125j CLI-128 IMG-75 with the daemon stopped the lock is free: chad health exits 4, and chad status exits 4 and prints what the files say, state/version included", async () => {
  const running = await scenario()
  const { data } = running
  await running.logged("boot.ready")
  expect(await running.stop()).toBe(0)
  const lock = join(data, "state/daemon.lock")

  expect(await running.chad(["health"])).toEqual({
    stdout: "",
    stderr: `chad health: no daemon (lock ${lock} is free)\n`,
    code: 4,
  })
  expect(await running.chad(["status"])).toEqual({
    stdout: [
      `daemon: not running (lock ${lock} is free)`,
      `version: chad ${version}, volume written by chad ${version}`,
      "",
    ].join("\n"),
    stderr: "",
    code: 4,
  })
})
