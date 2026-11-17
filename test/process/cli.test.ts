import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { type Server, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration } from "effect"
import { expect, it, onTestFinished } from "vitest"
import * as Lock from "../../dist/Lock.js"
import { chad, start } from "../support/cli.ts"

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

it("a daemon killed with kill -9 frees the lock at once, and the next chad serve removes the socket file it left and boots", async () => {
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

it("a second chad serve on the volume exits 1, and a daemon stopped with SIGSTOP still holds the lock while chad health calls it starting or frozen and exits 4", async () => {
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

it("runCli owns the signals of a client command: one that SIGTERM or SIGINT ends while it waits for the daemon exits 130", async () => {
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
