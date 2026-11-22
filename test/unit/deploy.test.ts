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
import { parse } from "yaml"

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
  git("init", "-q", "-b", "applied")
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

it("an install whose seed fails part way fails, and the next run finishes it, puts the desktop and the dashboard on the tailnet alone and leaves the firewall alone", () => {
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
  const seeded = JSON.parse(git("show", "HEAD:chad.json"))
  expect(seeded.plugins.asphodel.settings.url).toBe("http://asphodel:7720")
  expect(seeded.plugins["stale-tabs"]).toBeUndefined()
  expect(git("show", "HEAD:skills/browser/SKILL.md")).toBe(
    readFileSync(join(root, "deploy/browser/SKILL.md"), "utf8"),
  )
  expect(
    JSON.parse(git("show", "HEAD:mcp.json")).mcpServers.browse,
  ).toMatchObject({ command: "browse", args: ["mcp"] })
  // browse is installed before the apply that adds its MCP server, so that apply connects it.
  expect(calls().indexOf("browse set hostname 0.0.0.0")).toBeLessThan(
    calls().indexOf("chad apply"),
  )
  // browse is installed, its relay opened to Chromium's container, and the extension paired.
  expect(calls().filter((call) => call.startsWith("browse "))).toEqual([
    "browse set hostname 0.0.0.0",
    "browse pair --list",
    "browse pair --wait-seconds 600",
  ])
  expect(readFileSync(join(fake, "secrets"), "utf8")).toBe("ASPHODEL_TOKEN\n")
  expect(calls().filter((call) => call.startsWith("ufw "))).toEqual([])

  // Compose publishes the desktop and the dashboard on the server's loopback alone, and the browser shares no
  // network with asphodel. `tailscale serve` takes both ports to the tailnet, the dashboard before asphodel is set up
  // too. Nothing calls `tailscale funnel`, which would take them to the internet.
  const compose = parse(
    readFileSync(join(root, "deploy/compose.yaml"), "utf8"),
  ) as {
    services: Record<
      string,
      {
        ports?: ReadonlyArray<string>
        networks?: ReadonlyArray<string> | Record<string, unknown>
      }
    >
  }
  const { services } = compose
  expect(
    Object.values(services).flatMap((service) => service.ports ?? []),
  ).toEqual(["127.0.0.1:7720:7720", "127.0.0.1:3000:3000"])
  const networks = (name: string) => {
    const listed = services[name]?.networks ?? []
    return Array.isArray(listed) ? listed : Object.keys(listed)
  }
  expect(
    networks("chromium").filter((network) =>
      networks("asphodel").includes(network),
    ),
  ).toEqual([])
  expect(
    calls().filter((call) => /^tailscale (serve|funnel)\b/.test(call)),
  ).toEqual([
    "tailscale serve --bg --https=8443 http://127.0.0.1:3000",
    "tailscale serve --bg --https=9443 http://127.0.0.1:7720",
  ])
})

it("an upgrade from before browse is applied once as the tree it worked out, keeps the owner's files, and never publishes or writes over a draft, when it is cut or raced too", () => {
  const { fake, git, install, calls } = server()
  writeFileSync(join(fake, "tailnet"), "100.64.0.7\n")
  expect(install([]).status).toBe(0)
  const applies = () => calls().filter((call) => call === "chad apply")
  const work = join(fake, "data/repo/work")
  const read = (path: string) => readFileSync(join(work, path), "utf8")
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), text)
  }
  const asphodel = JSON.parse(read("chad.json")).plugins.asphodel
  const files = { command: "npx", args: ["-y", "files-server"] }
  const withoutBrowse = JSON.stringify({ mcpServers: { files } }) + "\n"

  // A volume an earlier install seeded: the stale-tabs entry, the owner's own MCP server and no browse, and an applied
  // file of theirs at the name the installer once staged its rewrite under.
  rmSync(join(fake, "data/home/.deploy-browse-mcp"))
  write(
    "chad.json",
    JSON.stringify(
      {
        plugins: {
          asphodel,
          "stale-tabs": {
            enabled: true,
            settings: { url: "http://172.30.72.10:9223" },
          },
        },
      },
      null,
      2,
    ) + "\n",
  )
  write("mcp.json", withoutBrowse)
  write("chad.json.new", "the owner's\n")
  git("add", "-A")
  git("commit", "-qm", "an earlier seed")
  const before = git("rev-parse", "applied").trim()

  // A draft of mcp.json that names browse is not the applied one: nothing is moved in or applied, and once discarded
  // the upgrade still adds browse.
  const draft = JSON.stringify({ mcpServers: { files, browse: files } }) + "\n"
  write("mcp.json", draft)
  expect(install([]).status).toBe(0)
  expect(read("mcp.json")).toBe(draft)
  expect(git("rev-parse", "applied").trim()).toBe(before)
  git("checkout", "--", "mcp.json")

  // A save of the owner's to mcp.json that comes in as the installer swaps its own in is put back, and the change it
  // conflicts with is not published.
  const saved = JSON.stringify({ mcpServers: { files, mine: files } }) + "\n"
  const saveBeforeMv = () =>
    writeFileSync(
      join(fake, "before-mv"),
      `[ "\${@: -1}" = mcp.json ] && printf %s '${saved}' > '${work}/mcp.json'\n`,
    )
  saveBeforeMv()
  expect(install([]).status).toBe(0)
  expect(read("mcp.json")).toBe(saved)
  expect(git("rev-parse", "applied").trim()).toBe(before)
  git("checkout", "--", "mcp.json")

  // The same save, with the installer stopped just after its swap took the save out of work/: the next run puts the
  // owner's bytes back before it looks at work/, and publishes nothing.
  saveBeforeMv()
  writeFileSync(
    join(fake, "after-mv"),
    `[ "$1" = --exchange ] && [ "\${@: -1}" = mcp.json ]\n`,
  )
  expect(install([]).status).not.toBe(0)
  expect(read("mcp.json")).not.toBe(saved)
  expect(install([]).status).toBe(0)
  expect(read("mcp.json")).toBe(saved)
  expect(git("rev-parse", "applied").trim()).toBe(before)
  git("checkout", "--", "mcp.json")

  // An edit of the owner's that comes in as the apply snapshots work/ is not published with it.
  writeFileSync(
    join(fake, "before-apply"),
    `mkdir -p '${work}/skills/mine' && echo draft > '${work}/skills/mine/SKILL.md'\n`,
  )
  expect(install([]).status).not.toBe(0)
  expect(git("rev-parse", "applied").trim()).toBe(before)
  expect(read("skills/mine/SKILL.md")).toBe("draft\n")

  // The next run sees the draft and leaves it, unpublished.
  expect(install([]).status).toBe(0)
  expect(git("rev-parse", "applied").trim()).toBe(before)
  expect(read("skills/mine/SKILL.md")).toBe("draft\n")

  // With the draft gone, a run cut part way through moving its files in is finished from git's copy of them.
  rmSync(join(work, "skills/mine"), { recursive: true })
  git("checkout", "--", "chad.json")
  expect(install([]).status).toBe(0)
  expect(applies()).toHaveLength(2)
  expect(JSON.parse(git("show", "applied:chad.json")).plugins).toEqual({
    asphodel,
  })
  expect(JSON.parse(git("show", "applied:mcp.json")).mcpServers).toEqual({
    files,
    browse: { command: "browse", args: ["mcp"], callTimeout: 660000 },
  })
  expect(git("show", "applied:chad.json.new")).toBe("the owner's\n")
  expect(git("status", "--porcelain")).toBe("")
  expect(install([]).status).toBe(0)
  expect(applies()).toHaveLength(2)

  // A stale-tabs entry the owner changed, and an mcp.json they took browse back out of, are theirs.
  const owners =
    JSON.stringify(
      {
        plugins: {
          asphodel,
          "stale-tabs": {
            enabled: true,
            settings: { url: "http://172.30.72.10:9223", maxAge: "12 hours" },
          },
        },
      },
      null,
      2,
    ) + "\n"
  write("chad.json", owners)
  write("mcp.json", withoutBrowse)
  git("commit", "-qam", "the owner's config")
  expect(install([]).status).toBe(0)
  expect(read("chad.json")).toBe(owners)
  expect(read("mcp.json")).toBe(withoutBrowse)
  expect(git("status", "--porcelain")).toBe("")
  expect(applies()).toHaveLength(2)
  // It runs the installer ten times, each a few dozen processes, so its time limit, like a daemon
  // scenario's, only bounds a hang.
}, 20_000)

it("a key that does not join the server starts no container", () => {
  const { fake, install, calls } = server()
  const key = { TS_AUTHKEY: "tskey-auth-test" }
  const started = (command: string) =>
    calls().filter((call) => call.startsWith(command))

  // A server that is already on a tailnet, which the key would not be used on.
  writeFileSync(join(fake, "tailnet"), "100.64.0.7\n")
  expect(install([], key).status).not.toBe(0)
  expect(started("tailscale up")).toEqual([])
  expect(started("docker compose up")).toEqual([])

  // A join that fails.
  rmSync(join(fake, "tailnet"))
  writeFileSync(join(fake, "fail-join"), "")
  expect(install([], key).status).not.toBe(0)
  expect(started("tailscale up")).toHaveLength(1)
  expect(started("docker compose up")).toEqual([])
})

it("lockdown closes the public ports only from a session that came in over Tailscale, and only once it has seen that no other rule opens one", () => {
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
  writeFileSync(join(fake, "ufw-rules"), "ufw allow 22/tcp\n")
  const open = install(["lockdown"], tailnet)
  expect(open.status).not.toBe(0)
  expect(open.stderr).toContain("ufw allow 22/tcp")
  expect(changes()).toEqual([])

  // A firewall that cannot list its rules, which is not one with no rules.
  rmSync(join(fake, "ufw-rules"))
  writeFileSync(join(fake, "fail-ufw"), "")
  expect(install(["lockdown"], tailnet).status).not.toBe(0)
  expect(changes()).toEqual([])

  rmSync(join(fake, "fail-ufw"))
  expect(install(["lockdown"], tailnet).status).toBe(0)
  expect(changes()).toEqual([
    "ufw default deny incoming",
    "ufw default allow outgoing",
    "ufw allow in on tailscale0",
    "ufw allow 41641/udp",
    "ufw --force enable",
  ])
})
