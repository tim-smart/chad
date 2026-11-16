import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { builtinModules } from "node:module"
import { type Server, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Layer, Scope, Stream } from "effect"
import { expect, it, onTestFinished } from "vitest"
import * as Lock from "../../dist/Lock.js"
import * as Messages from "../../dist/Messages.js"
import { OpenRpcs, Rpcs, layerVersionCheck } from "../../dist/Rpcs.js"
import { version } from "../../dist/Version.js"
import { chad, owner, start } from "../support/cli.ts"
import * as Platform from "../support/platform.ts"
import { json, path, read } from "../support/repo.ts"

/** A volume of this test's own, removed when the test is over. */
const volume = () => {
  const data = mkdtempSync(join(tmpdir(), "chad-cli-"))
  onTestFinished(() => rmSync(data, { recursive: true, force: true }))
  return data
}

/** Starts `chad serve` on the volume and waits for the boot to finish. The test's end kills what it left running. */
const serve = async (data: string) => {
  const daemon = start(["serve"], { CHAD_DATA: data })
  onTestFinished(() => void daemon.child.kill("SIGKILL"))
  await daemon.printed("event=boot.ready")
  return daemon
}

/** Holds the daemon lock of a volume in this process, as a daemon that has not listened yet does. */
const hold = (data: string) => {
  mkdirSync(join(data, "state"), { recursive: true })
  const release = Lock.take(join(data, "state/daemon.lock"), Duration.zero)
  if (release === undefined) throw new Error("the lock is held")
  onTestFinished(release)
  return release
}

/** A socket that accepts a connection and never answers, as a frozen daemon's does. */
const silent = async (path: string) => {
  let connections = 0
  let connected = () => {}
  const server: Server = createServer(() => {
    connections++
    connected()
  })
  mkdirSync(join(path, ".."), { recursive: true })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  onTestFinished(() => void server.close())
  return {
    connections: () => connections,
    /** Resolves on the next connection. */
    next: () => new Promise<void>((resolve) => (connected = resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const frozen = (data: string) =>
  `chad health: daemon is starting or frozen (lock held, no answer on ${join(data, "run/chad.sock")} in 2s)\n`

it("CLI-24 CLI-13 STO-26 a daemon killed with kill -9 frees the lock at once, and the next chad serve removes the socket file it left and boots", async () => {
  const data = volume()
  const first = await serve(data)
  expect((await chad(["health"], { CHAD_DATA: data })).code).toBe(0)

  first.child.kill("SIGKILL")
  await first.done
  expect(await chad(["health"], { CHAD_DATA: data })).toMatchObject({
    stderr: `chad health: no daemon (lock ${join(data, "state/daemon.lock")} is free)\n`,
    code: 4,
  })
  // The killed daemon could not remove its socket.
  expect(statSync(join(data, "run/chad.sock")).isSocket()).toBe(true)

  // A listen at a path that still holds a file fails, so a daemon that answers there removed the file first.
  const second = await serve(data)
  expect((await chad(["health"], { CHAD_DATA: data })).code).toBe(0)
  second.child.kill("SIGTERM")
  expect((await second.done).code).toBe(0)
}, 60_000)

it("OV-20 IMG-59 CLI-25 CLI-28 CLI-15 IMG-75 a second chad serve on the volume exits 1, and a daemon stopped with SIGSTOP still holds the lock while chad health calls it starting or frozen and exits 4", async () => {
  const data = volume()
  const daemon = await serve(data)

  const second = await chad(["serve"], { CHAD_DATA: data })
  expect(second.code).toBe(1)
  expect(second.stdout).toMatch(/event=boot\.refused reason=lock/)
  expect(second.stdout).not.toContain("boot.started")
  expect((await chad(["health"], { CHAD_DATA: data })).code).toBe(0)

  daemon.child.kill("SIGSTOP")
  expect(Lock.test(join(data, "state/daemon.lock"))).toBe("held")
  expect(await chad(["health"], { CHAD_DATA: data })).toEqual({
    stdout: "",
    stderr: frozen(data),
    code: 4,
  })
  daemon.child.kill("SIGCONT")
  expect((await chad(["health"], { CHAD_DATA: data })).code).toBe(0)

  daemon.child.kill("SIGTERM")
  expect((await daemon.done).code).toBe(0)
}, 60_000)

it("CLI-15 with the lock held, a socket that is missing, one that refuses the connection and one that accepts it and never answers all read as starting or frozen: exit 4, one connection, no file touched", async () => {
  const data = volume()
  hold(data)
  const socket = join(data, "run/chad.sock")
  const listing = () => readdirSync(data, { recursive: true }).sort()
  const health = () => chad(["health"], { CHAD_DATA: data })
  const expected = { stdout: "", stderr: frozen(data), code: 4 }

  let before = listing()
  expect(await health()).toEqual(expected)
  expect(listing()).toEqual(before)

  mkdirSync(join(data, "run"))
  writeFileSync(socket, "")
  before = listing()
  expect(await health()).toEqual(expected)
  expect(listing()).toEqual(before)

  rmSync(socket)
  const server = await silent(socket)
  before = listing()
  expect(await health()).toEqual(expected)
  expect(server.connections()).toBe(1)
  expect(listing()).toEqual(before)
}, 30_000)

it("TST-209 CLI-51a runCli owns the signals of a client command: one that SIGTERM or SIGINT ends while it waits for the daemon exits 130", async () => {
  const data = volume()
  hold(data)
  const server = await silent(join(data, "run/chad.sock"))
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const connected = server.next()
    const health = start(["health"], { CHAD_DATA: data })
    // The command has connected, so it is running and waits for an answer that never comes.
    await connected
    health.child.kill(signal)
    expect((await health.done).code).toBe(130)
  }
}, 30_000)

it("CLI-21 CLI-22 CLI-127 CLI-128 IMG-74 IMG-75 chad health tests the lock before it pings, so it exits 4 with the lock free even when a daemon answers, and every request carries the CLI's chad version, which a daemon of another version still answers for health and status", async () => {
  const data = volume()
  mkdirSync(join(data, "run"))
  const versions: Array<string | undefined> = []
  const scope = Effect.runSync(Scope.make())
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  // A daemon of another chad version, which notes the version each request carries.
  await Effect.runPromise(
    Layer.buildWithScope(
      Platform.serve(
        OpenRpcs,
        Layer.merge(
          OpenRpcs.toLayer({
            Ping: (_, { headers }) =>
              Effect.sync(() => {
                versions.push(headers["chad-version"])
                return "pong"
              }),
            Status: (_, { headers }) =>
              Effect.sync(() => {
                versions.push(headers["chad-version"])
                return {
                  version: "9.9.9",
                  effect: "4.0.0",
                  phase: "ready" as const,
                  filesystem: [],
                  connections: [],
                }
              }),
          }),
          layerVersionCheck("9.9.9"),
        ),
        join(data, "run/chad.sock"),
      ),
      scope,
    ),
  )

  expect(await chad(["health"], { CHAD_DATA: data })).toMatchObject({
    stdout: "",
    code: 4,
  })
  expect(versions).toEqual([])

  hold(data)
  expect(await chad(["health"], { CHAD_DATA: data })).toEqual({
    stdout: "chad health: ok\n",
    stderr: "",
    code: 0,
  })
  const status = await chad(["status"], { CHAD_DATA: data })
  expect(status).toMatchObject({ code: 0, stderr: "" })
  expect(status.stdout).toBe(
    "daemon: up (ready)\nversion: chad 9.9.9, effect 4.0.0\n",
  )
  expect(version).toBe(json("package.json").version)
  expect(versions).toEqual([version, version])
}, 30_000)

it("CLI-45 CLI-49a CLI-162 CLI-204 CLI-216 a usage error prints the usage and exits 2, chad keeps --help and --version of effect's own flags, and nothing is coloured when the output is not a terminal", async () => {
  const data = volume()
  // Colour is asked for, and the output is a pipe.
  const env = { CHAD_DATA: data, FORCE_COLOR: "1", TERM: "xterm-256color" }
  const usage = [
    ["frob"],
    ["health", "extra"],
    ["health", "--wizard"],
    ["health", "--completions", "bash"],
    ["health", "--log-level", "debug"],
  ]
  for (const args of usage) {
    const ran = await chad(args, env)
    expect(ran.code, args.join(" ")).toBe(2)
    expect(ran.stdout + ran.stderr).toMatch(/USAGE\n {2}chad /)
    expect(ran.stdout + ran.stderr).not.toContain("\u001b")
  }
  expect((await chad(["frob"], env)).stderr).toContain(
    'Unknown subcommand "frob"',
  )

  for (const args of [[], ["--help"], ["health", "--help"]]) {
    const help = await chad(args, env)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("--help")
    expect(help.stdout).toContain("--version")
    expect(help.stdout).not.toMatch(/--wizard|--completions|--log-level/)
    expect(help.stdout).not.toContain("\u001b")
  }
  expect((await chad([], env)).stdout).toMatch(
    /SUBCOMMANDS\n\s+health .*\n\s+status /,
  )
  expect(await chad(["--version"], env)).toEqual({
    stdout: `chad v${version}\n`,
    stderr: "",
    code: 0,
  })

  // The CLI finds the volume as the daemon does: CHAD_DATA, and /data without it.
  expect((await chad(["status"], env)).stdout).toContain(
    `daemon: not running (lock ${data}/state/daemon.lock is free)\n`,
  )
  expect((await chad(["health"], { CHAD_DATA: undefined })).stderr).toBe(
    "chad health: no daemon (lock /data/state/daemon.lock is free)\n",
  )
  expect(readdirSync(data)).toEqual([])
}, 60_000)

it("IMG-16b CLI-142 CLI-143 CLI-144 the client is one esbuild file with effect inside it, which the few lines of bin/chad.js load for every command but serve, and no compile cache is used", async () => {
  const bundle = read("dist/cli.bundle.js")
  // Every module the file imports is one of Node's own, so effect is in the file and not beside it.
  const imported = [
    ...bundle.matchAll(/^import [^;]*? from "([^"]+)";$/gm),
  ].map((match) => match[1] ?? "")
  expect(imported.length).toBeGreaterThan(5)
  // The model layer that `chad model` with no daemon tries (MOD-90) brings modules that import Node's own by their
  // bare names, and CommonJS ones that require them through the banner's `require`. ajv's code generator holds
  // `require` calls of its own runtime as text, which never run in chad. clanka's `claude` provider imports its SDK
  // when a turn runs on it, which chad refuses (MOD-5), so the build leaves the SDK out.
  const node = (name: string) =>
    name.startsWith("node:") || builtinModules.includes(name)
  expect(imported.filter((name) => !node(name))).toEqual([])
  const loaded = [...bundle.matchAll(/\b(?:import|require)\("([^"]+)"\)/g)].map(
    (match) => match[1] ?? "",
  )
  expect(
    loaded.filter(
      (name) =>
        !node(name) &&
        !name.startsWith("ajv") &&
        name !== "@anthropic-ai/claude-agent-sdk",
    ),
  ).toEqual([])
  expect(bundle).toContain("effect/Cause")
  const launcher = read("bin/chad.js")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("//"))
  expect(launcher).toEqual([
    "#!/usr/bin/env node",
    'if (process.argv[2] === "serve") {',
    '  await import("../dist/daemon.js")',
    "} else {",
    '  await import("../dist/cli.bundle.js")',
    "}",
  ])
  expect(json("package.json").scripts.build).toContain(
    "esbuild src/cli.ts --bundle --platform=node --format=esm --target=node26 --outfile=dist/cli.bundle.js",
  )
  expect(launcher.join("\n") + bundle + read("src/daemon.ts")).not.toMatch(
    /enableCompileCache|NODE_COMPILE_CACHE/,
  )

  // Away from the checkout there is no node_modules, so the effect that runs is the one in the file.
  const copy = volume()
  mkdirSync(join(copy, "bin"))
  mkdirSync(join(copy, "dist"))
  cpSync(path("bin/chad.js"), join(copy, "bin/chad.js"))
  cpSync(path("dist/cli.bundle.js"), join(copy, "dist/cli.bundle.js"))
  cpSync(path("package.json"), join(copy, "package.json"))
  expect(existsSync(join(copy, "node_modules"))).toBe(false)
  const ran = spawnSync(
    process.execPath,
    [join(copy, "bin/chad.js"), "health"],
    { env: owner({ CHAD_DATA: join(copy, "data") }), encoding: "utf8" },
  )
  expect(ran.status).toBe(4)
  expect(ran.stderr).toBe(
    `chad health: no daemon (lock ${join(copy, "data/state/daemon.lock")} is free)\n`,
  )
}, 30_000)

it("CLI-59 CLI-218 the CLI sends its CHAD_SESSION with every request, and a daemon that goes away during a call ends the command with exit 4", async () => {
  const data = volume()
  mkdirSync(join(data, "run"))
  hold(data)
  const sessions: Array<string | undefined> = []
  const scope = Effect.runSync(Scope.make())
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const noted = <A>(headers: Readonly<Record<string, string>>, answer: A) =>
    Effect.sync(() => {
      sessions.push(headers["chad-session"])
      return answer
    })
  // A daemon that notes the session id of each request, and goes away when it is asked for the connections.
  await Effect.runPromise(
    Layer.buildWithScope(
      Platform.serve(
        Rpcs,
        Layer.merge(
          Rpcs.toLayer({
            Ping: (_, { headers }) => noted(headers, "pong"),
            Status: (_, { headers }) =>
              noted(headers, {
                version,
                effect: "4.0.0",
                phase: "ready" as const,
                filesystem: [],
                connections: [],
              }),
            ConnectionList: () =>
              Effect.andThen(
                Effect.promise(() =>
                  Effect.runPromise(Scope.close(scope, Exit.void)),
                ),
                Effect.never,
              ),
            ConnectionCheck: () => Effect.succeed([]),
            ConnectionChange: () => Effect.succeed({ changed: false }),
            Login: () => Stream.empty,
            Logout: () => Effect.succeed({ spec: "openai-compat/fake" }),
            Model: () => Stream.empty,
            Repository: () => Stream.empty,
          }),
          layerVersionCheck(version),
        ),
        join(data, "run/chad.sock"),
      ),
      scope,
    ),
  )

  const session = "0b4b1c9e-55d0-4d0c-9f0a-3e8f0f7f2a11"
  for (const CHAD_SESSION of [session, "daemon", undefined]) {
    const env = { CHAD_DATA: data, CHAD_SESSION }
    expect((await chad(["status"], env)).code).toBe(0)
    expect((await chad(["health"], env)).code).toBe(0)
  }
  // Each command makes one call, and each call carries the id as the variable gave it.
  expect(sessions).toEqual([
    session,
    session,
    "daemon",
    "daemon",
    undefined,
    undefined,
  ])

  expect(await chad(["connection", "list"], { CHAD_DATA: data })).toEqual({
    stdout: "",
    stderr: Messages.daemonGone("connection list") + "\n",
    code: 4,
  })
})

it("CLI-219 CLI-222 CLI-223 with no daemon a connection command creates no data directory, ends with exit 1 on a file it cannot read or that holds no connections, and with exit 2 when the token it is given is empty", async () => {
  const data = volume()
  const absent = join(data, "absent")
  const failed = (code: number, message: string) => ({
    stdout: "",
    stderr: message + "\n",
    code,
  })
  expect(
    await chad(["connection", "add", "local"], { CHAD_DATA: absent }),
  ).toEqual(failed(1, Messages.volumeMissing("connection add", absent)))
  expect(existsSync(absent)).toBe(false)

  const env = { CHAD_DATA: data }
  const token = join(data, "no-such-token")
  expect(
    await chad(["connection", "add", "discord", "--token-file", token], env),
  ).toEqual(failed(1, Messages.unreadable("connection add", token, "ENOENT")))
  // A token that is only white space is no token, from a pipe or from a file.
  writeFileSync(token, " \n")
  expect(
    await chad(["connection", "add", "discord", "--token-file", token], env),
  ).toEqual(failed(2, Messages.noToken("connection add")))
  expect(await chad(["connection", "add", "discord"], env, "\n")).toEqual(
    failed(2, Messages.noToken("connection add")),
  )
  expect(existsSync(join(data, "secrets"))).toBe(false)

  const file = join(data, "secrets/connections.json")
  mkdirSync(join(data, "secrets"))
  for (const content of ["not json", JSON.stringify({ format: 1 })]) {
    writeFileSync(file, content)
    expect(await chad(["connection", "list"], env)).toEqual(
      failed(1, Messages.malformed("connection list", file)),
    )
    expect(await chad(["owner", "add", "local", "ada"], env)).toEqual(
      failed(1, Messages.malformed("owner add", file)),
    )
    expect(readFileSync(file, "utf8")).toBe(content)
  }
  rmSync(file)
  mkdirSync(file)
  expect(await chad(["connection", "list"], env)).toEqual(
    failed(1, Messages.unreadable("connection list", file, "EISDIR")),
  )
})
