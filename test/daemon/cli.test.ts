import { mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { version } from "../../dist/Version.js"
import { git } from "../support/applied.ts"
import { fresh, scenario } from "../support/driver.ts"
import { json, read } from "../support/repo.ts"

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

/** The lines of a `chad status`, without the warnings about the filesystem the suite happens to run on. */
const facts = (stdout: string) =>
  stdout.split("\n").filter((line) => !line.startsWith("filesystem: "))

test("chad health and chad status reach the running daemon over the socket at run/chad.sock, as the owner's shell does", async () => {
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
  const first = git(join(running.data, "repo/work"), ["rev-parse", "HEAD"])
  expect(facts(status.stdout).slice(0, 8)).toEqual([
    "daemon: up (ready)",
    `version: chad ${json("package.json").version}, effect ${json("node_modules/effect/package.json").version}`,
    "safe mode: off",
    `applied: ${first.slice(0, 7)} First commit`,
    "work: no changes since the applied commit",
    "model: openai-compat/fake (needs no login)",
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

test("run/ gets mode 0700 on a start that finds it wider, the socket gets 0600 after the listen, and the umask is left alone", async () => {
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
