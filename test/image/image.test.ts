import { spawnSync } from "node:child_process"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { owner } from "../support/driver.ts"
import {
  buildImage,
  cleanup,
  command,
  engine,
  image,
  type Container,
  container,
  exec,
  fakes as startFakes,
  healthy,
  lines,
  logs,
  modelUrl,
  network,
  output,
  type Options,
  ready,
  type Result,
  reserve,
  run,
  scenario,
  start,
  stop,
  volume,
} from "../support/image.ts"
import { json } from "../support/repo.ts"

vi.setConfig({ testTimeout: 120_000 })

/** The commands among these that the image's PATH holds. */
const onPath = (names: ReadonlyArray<string>, options?: Options) =>
  lines(
    "for name in " + names.join(" ") + '; do command -v "$name"; done; true',
    options,
  )

const manifest = json("package.json")
const volumeBins = ["/data/home/.npm-global/bin", "/data/home/.local/bin"]

beforeAll(async () => {
  await buildImage()
}, 900_000)

afterAll(cleanup, 120_000)

/** Makes an npm package with one command, chad-tool, and installs it as an npm global from its own tarball. */
const installGlobal = [
  "mkdir /tmp/tool && cd /tmp/tool",
  'printf \'%s\' \'{"name":"chad-tool","version":"1.0.0","bin":{"chad-tool":"tool.js"}}\' > package.json',
  "printf '%s\\n' '#!/usr/bin/env node' 'console.log(\"an npm global\")' > tool.js",
  "npm pack --silent > /dev/null",
  "npm install --global --no-audit --no-fund --silent ./chad-tool-1.0.0.tgz",
  "cd /data",
].join(" && ")

describe("installs, PATH and the caches", () => {
  it("what is installed on the volume is there in the next container, and nothing there shadows a tool of the image", () => {
    const flags = ["--volume", volume() + ":/data"]
    const tools = ["git", "chad", "node", "npm", "rg"]
    output(
      [
        installGlobal,
        "mkdir -p /data/home/.local/bin",
        "printf '%s\\n' '#!/bin/sh' 'echo a dropped binary' > /data/home/.local/bin/dropped",
        "chmod +x /data/home/.local/bin/dropped",
        ...volumeBins.flatMap((directory) =>
          tools.map(
            (tool) =>
              "cp /data/home/.local/bin/dropped " + directory + "/" + tool,
          ),
        ),
      ].join(" && "),
      { flags },
    )
    // Another container on the same volume, as after the first was replaced.
    expect(
      lines("chad-tool && dropped && uv tool dir --bin && uv tool dir", {
        flags,
      }),
    ).toEqual([
      "an npm global",
      "a dropped binary",
      "/data/home/.local/bin",
      expect.stringMatching(/^\/data\/home\//),
    ])
    expect(onPath(tools, { flags })).toEqual([
      "/usr/bin/git",
      "/usr/local/bin/chad",
      "/usr/local/bin/node",
      "/usr/local/bin/npm",
      "/usr/bin/rg",
    ])
  })
})

describe("the image booted on an empty named volume, and then stopped", () => {
  let processes: ReadonlyArray<string>
  let directories: ReadonlyArray<string>
  let version: string
  let stdout: string
  let exitCode: number

  beforeAll(async () => {
    const container = start("--volume", volume() + ":/data")
    await ready(container)
    processes = exec(container, "ps -e -o pid=,uid=,args=")
      .split("\n")
      .map((line) => line.trim().replace(/ +/, " ").replace(/ +/, " "))
    directories = exec(container, "cd /data && stat -c '%n %U %a' *").split(
      "\n",
    )
    version = exec(container, "cat /data/state/version")
    exitCode = stop(container)
    stdout = logs(container).stdout
  })

  it("the built image runs the real chad serve on an empty volume as uid 1000, and a stop ends it with exit code 0", () => {
    expect(stdout).toContain("event=boot.started")
    expect(processes).toEqual(
      expect.arrayContaining([
        "1 1000 /usr/bin/tini -- /usr/local/bin/chad serve",
        expect.stringMatching(/^\d+ 1000 node \/usr\/local\/bin\/chad serve$/),
      ]),
    )
    expect(processes.map((line) => line.split(" ")[1])).toEqual(
      processes.map(() => "1000"),
    )
    expect(directories).toEqual(
      expect.arrayContaining([
        "cache node 755",
        "db node 755",
        "home node 755",
        "logs node 755",
        "run node 700",
        "secrets node 700",
        "sessions node 755",
        "state node 755",
      ]),
    )
    expect(version).toBe(manifest.version)
    expect(exitCode).toBe(0)
  })
})

describe("the owner talks to the image", () => {
  const reply = "Hello from the image."
  let data: string
  let shared: string
  let url: string
  let added: ReadonlyArray<Result>
  let health: string
  let answers: ReadonlyArray<string>
  let status: ReadonlyArray<string>
  let daemon: Container

  beforeAll(async () => {
    data = volume()
    shared = network()
    const onVolume = ["--volume", data + ":/data"]
    // The owner's two commands, each a run of the image's own `chad` on the fresh volume, before any daemon.
    added = [
      command(onVolume, "connection", "add", "local", "--name", "local"),
      command(onVolume, "owner", "add", "local", owner),
    ]
    const fakesName = reserve()
    url = modelUrl(fakesName)
    const daemonName = start(
      ...onVolume,
      "--network",
      shared,
      "--env",
      "CHAD_MODEL=openai-compat/fake",
      "--env",
      "CHAD_OPENAI_API_URL=" + url,
      "--env",
      "CHAD_OPENAI_API_KEY=fake-key",
    )
    await scenario({ daemon: daemonName, fakes: fakesName }, async (step) => {
      step("waiting for the daemon's boot.ready")
      await ready(daemonName)
      step("starting the second container")
      const fakes = await startFakes(fakesName, shared, data)
      step("running chad health in the daemon's container")
      health = exec(daemonName, "chad health")
      step("waiting for the engine to report the daemon's container healthy")
      await healthy(daemonName)
      step("delivering the owner's message")
      await fakes.model.script([{ text: reply }])
      const thread = await fakes.chat.makeThread("direct")
      const event = await fakes.chat.userPosts(thread, {
        text: "hello",
        authorId: owner,
      })
      expect(await fakes.chat.deliver(event)).toBe(true)
      step("waiting for chad's answer")
      answers = (await fakes.chat.answers(thread, 1)).map(({ text }) => text)
      step("running chad status in the daemon's container")
      status = exec(daemonName, "chad status").split("\n")
      daemon = container(daemonName)
    })
  }, 120_000)

  it("the image answers an owner's message through the local platform and fake model server, and the engine reports it healthy", () => {
    expect(added.map(({ status, stdout }) => [status, stdout])).toEqual([
      [0, Messages.connectionAdded("local", "local") + "\n"],
      [0, Messages.ownerAdded(owner, "local") + "\n"],
    ])
    expect(health).toBe(Messages.healthy())
    expect(daemon.State.Health.Status).toBe("healthy")
    expect(answers).toEqual([reply])
    expect(status).toEqual(
      expect.arrayContaining([
        "daemon: up (ready)",
        "connection: local (local)",
      ]),
    )
  })
})

describe("a backup and a restore in containers, as docs/running.md gives them", () => {
  /** An engine command whose standard output is bytes, such as a tar, with bytes for its standard input. */
  const bytes = (args: ReadonlyArray<string>, input?: Buffer) => {
    const { status, stdout, stderr } = spawnSync(engine, args, {
      input,
      maxBuffer: 256 * 1024 * 1024,
    })
    return { status, stdout, stderr: stderr.toString() }
  }
  const volumeTop = [
    "cache",
    "db",
    "home",
    "logs",
    "repo",
    "run",
    "secrets",
    "sessions",
    "state",
  ]

  it("a running chad is backed up through docker exec and by a one-off container on its volume as the CronJob runs it, a second chad serve on that volume is refused the lock, and each tar restores with chad stopped onto an empty volume that boots with the secret", async () => {
    const first = volume()
    const daemon = start("--volume", `${first}:/data`)
    await ready(daemon)
    exec(daemon, "printf kept | chad secret set PROBE_TOKEN")

    // The lock holds across two containers that share one volume.
    const second = command(["--volume", `${first}:/data`], "serve")
    expect(second.status).toBe(1)
    expect(second.stdout).toContain("event=boot.refused")
    expect(second.stdout).toContain("reason=lock")

    // The docs' backup, to a file on the host.
    const piped = bytes(["exec", daemon, "chad", "backup", "-"])
    expect(piped.status, piped.stderr).toBe(0)
    expect(piped.stdout.subarray(0, 13).toString()).toBe("manifest.json")

    // The CronJob's backup: the image with a shell, the data volume and a destination, while chad runs.
    const backups = volume()
    output("chown 1000:1000 /backup", {
      flags: ["--user", "0", "--volume", `${backups}:/backup`],
    })
    const scheduled = run(
      "run",
      "--rm",
      "--volume",
      `${first}:/data`,
      "--volume",
      `${backups}:/backup`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      'exec chad backup "/backup/chad-$(date -u +%Y-%m-%d).tar"',
    )
    expect(scheduled.status, scheduled.stderr).toBe(0)
    expect(scheduled.stdout).toMatch(
      /^Backup written to \/backup\/chad-\d{4}-\d\d-\d\d\.tar\.$/m,
    )
    expect(stop(daemon)).toBe(0)

    // The docs' restore: chad stopped, a one-off container, the tar on standard input. The used volume is refused.
    const refused = bytes(
      [
        "run",
        "--rm",
        "-i",
        "--volume",
        `${first}:/data`,
        image,
        "restore",
        "-",
      ],
      piped.stdout,
    )
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(
      "chad restore: refused: /data is not empty",
    )
    const restored = volume()
    const restore = bytes(
      [
        "run",
        "--rm",
        "-i",
        "--volume",
        `${restored}:/data`,
        image,
        "restore",
        "-",
      ],
      piped.stdout,
    )
    expect(restore.status, restore.stderr).toBe(0)

    // The scheduled tar restores the same way.
    const other = volume()
    const fromSchedule = run(
      "run",
      "--rm",
      "--volume",
      `${other}:/data`,
      "--volume",
      `${backups}:/backup:ro`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      "exec chad restore /backup/chad-*.tar",
    )
    expect(fromSchedule.status, fromSchedule.stderr).toBe(0)
    expect(
      command(["--volume", `${other}:/data`], "secret", "list").stdout,
    ).toContain("PROBE_TOKEN")

    const back = start("--volume", `${restored}:/data`)
    await ready(back)
    await healthy(back)
    expect(exec(back, "chad secret list")).toContain("PROBE_TOKEN")
    expect(exec(back, "ls -A /data").split("\n")).toEqual(volumeTop)
    expect(stop(back)).toBe(0)
  })
})

describe("a boot the start-up check refuses", () => {
  const contents = (data: string) =>
    lines("find /data -mindepth 1", { flags: ["--volume", data + ":/data"] })

  it("a boot as uid 2000 on a fresh named volume exits 1, names uid 2000 and the owner uid 1000, and writes nothing", () => {
    const data = volume()
    const boot = command(["--user", "2000", "--volume", data + ":/data"])
    expect(boot.status).toBe(1)
    expect(boot.stdout).toMatch(
      /chad serve: cannot write \/data\. chad runs as uid 2000, gid \d+ and \/data is owned by uid 1000, gid 1000, mode 755\. Give the volume to uid 2000, for example: chown -R 2000:\d+ <volume>/,
    )
    expect(contents(data)).toEqual([])
  })

  it("a boot on a volume whose repo/ root made exits 1, names the owner uid 0 and uid 1000, and writes nothing", () => {
    const data = volume()
    const flags = ["--volume", data + ":/data"]
    output("mkdir /data/repo", { flags: [...flags, "--user", "0"] })
    const boot = command(flags)
    expect(boot.status).toBe(1)
    expect(boot.stdout).toContain(
      "chad serve: /data/repo is owned by uid 0, gid 0, mode 755 and chad runs as uid 1000. git refuses a repository owned by another user. Give it to uid 1000: chown -R 1000:1000 /data/repo",
    )
    expect(contents(data)).toEqual(["/data/repo"])
  })
})
