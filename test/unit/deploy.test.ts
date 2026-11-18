import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../..")

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/**
 * A server that has none of chad yet. `fixtures/deploy/server` stands in for the commands `deploy/install.sh` calls
 * there, each of which writes what it was called with to `calls`, and `fixtures/deploy/container` for chad's
 * container, on a new volume whose repo holds no plugin.
 */
const server = () => {
  const fake = mkdtempSync(join(tmpdir(), "chad-deploy-"))
  cleanups.push(() => rmSync(fake, { recursive: true, force: true }))
  const env = {
    PATH: `${join(fake, "server")}:${process.env["PATH"]}`,
    FAKE: fake,
    CHAD_DIR: join(fake, "opt"),
    GIT_CONFIG_GLOBAL: "/dev/null",
  }
  const sh = (command: string, args: ReadonlyArray<string>) => {
    const ran = spawnSync(command, args, { env, encoding: "utf8" })
    if (ran.status !== 0) throw new Error(`${command}: ${ran.stderr}`)
    return ran.stdout
  }
  cpSync(join(here, "fixtures/deploy"), fake, { recursive: true })
  // What the installer downloads is this checkout's deploy/, in a tree that has another directory of that name.
  cpSync(join(root, "deploy"), join(fake, "source/chad/deploy"), {
    recursive: true,
  })
  cpSync(
    join(here, "fixtures/deploy"),
    join(fake, "source/chad/test/unit/fixtures/deploy"),
    { recursive: true },
  )
  sh("tar", [
    "-czf",
    join(fake, "deploy.tgz"),
    "-C",
    join(fake, "source"),
    "chad",
  ])
  const work = join(fake, "data/repo/work")
  mkdirSync(work, { recursive: true })
  mkdirSync(join(fake, "data/home"))
  writeFileSync(join(work, "chad.json"), '{\n  "plugins": {}\n}\n')
  const git = (...args: ReadonlyArray<string>) =>
    sh("git", [
      "-C",
      work,
      "-c",
      "user.name=chad",
      "-c",
      "user.email=chad@localhost",
      ...args,
    ])
  git("init", "-q")
  git("add", "-A")
  git("commit", "-qm", "First commit")
  return {
    fake,
    git,
    /** `install.sh` with these arguments, and what it exited with. */
    install: (args: ReadonlyArray<string>, more: Record<string, string> = {}) =>
      spawnSync("bash", [join(root, "deploy/install.sh"), ...args], {
        env: { ...env, ...more },
        encoding: "utf8",
      }),
    /** Every call of a stand-in command so far. */
    calls: () =>
      existsSync(join(fake, "calls"))
        ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n")
        : [],
  }
}

it("an install whose seed fails part way fails, and the next run finishes it and leaves the firewall alone", () => {
  const { fake, git, install, calls } = server()
  const marker = join(fake, "data/home/.deploy-seeded")
  // The server is on a tailnet already, which alone closes nothing.
  writeFileSync(join(fake, "tailnet"), "100.64.0.7\n")
  writeFileSync(join(fake, "fail-apply"), "")

  expect(install([]).status).not.toBe(0)
  expect(existsSync(marker)).toBe(false)

  rmSync(join(fake, "fail-apply"))
  expect(install([]).status).toBe(0)
  expect(existsSync(marker)).toBe(true)
  expect(existsSync(join(fake, "opt/compose.yaml"))).toBe(true)
  expect(existsSync(join(fake, "opt/unit"))).toBe(false)
  expect(calls().filter((call) => call === "chad apply")).toHaveLength(1)
  expect(git("show", "HEAD:chad.json")).toContain("http://asphodel:7720")
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toContain(
    "skills/browser/SKILL.md",
  )
  expect(readFileSync(join(fake, "secrets"), "utf8")).toBe("ASPHODEL_TOKEN\n")
  expect(calls().filter((call) => call.startsWith("ufw "))).toEqual([])
})

it("a join that fails starts no container", () => {
  const { fake, install, calls } = server()
  writeFileSync(join(fake, "fail-join"), "")

  expect(install([], { TS_AUTHKEY: "tskey-auth-test" }).status).not.toBe(0)
  expect(calls().some((call) => call.startsWith("tailscale up"))).toBe(true)
  expect(
    calls().filter((call) => call.startsWith("docker compose up")),
  ).toEqual([])
})

it("lockdown closes the public ports only from a session that came in over Tailscale, and only when no other rule opens one", () => {
  const { fake, install, calls } = server()
  writeFileSync(join(fake, "tailnet"), "100.64.0.7\nfd7a:115c:a1e0::7\n")
  const changes = () =>
    calls().filter(
      (call) => call.startsWith("ufw ") && call !== "ufw show added",
    )

  // A session that arrived at the public address.
  const outside = install(["lockdown"], {
    SSH_CONNECTION: "203.0.113.5 50000 198.51.100.9 22",
  })
  expect(outside.status).not.toBe(0)
  expect(changes()).toEqual([])

  // A session over Tailscale, on a server whose firewall already lets SSH in from anywhere.
  const tailnet = { SSH_CONNECTION: "100.64.0.2 50000 100.64.0.7 22" }
  writeFileSync(
    join(fake, "ufw-rules"),
    "Added user rules (see 'ufw status' for running firewall):\nufw allow 22/tcp\n",
  )
  const open = install(["lockdown"], tailnet)
  expect(open.status).not.toBe(0)
  expect(open.stderr).toContain("ufw allow 22/tcp")
  expect(changes()).toEqual([])

  rmSync(join(fake, "ufw-rules"))
  expect(install(["lockdown"], tailnet).status).toBe(0)
  expect(changes()).toEqual([
    "ufw default deny incoming",
    "ufw default allow outgoing",
    "ufw allow in on tailscale0",
    "ufw allow 41641/udp",
    "ufw --force enable",
  ])
})
