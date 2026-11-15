import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { owner } from "../support/driver.ts"
import {
  buildImage,
  buildStage,
  cleanup,
  command,
  type Config,
  type Container,
  container,
  exec,
  fakes as startFakes,
  fakesFile,
  healthy,
  imageId,
  inspect,
  internal,
  lines,
  logs,
  modelUrl,
  network,
  type Options,
  output,
  ready,
  type Result,
  reserve,
  scenario,
  sh,
  start,
  stop,
  volume,
} from "../support/image.ts"
import type * as Model from "../support/model.ts"
import { json, read, root } from "../support/repo.ts"

vi.setConfig({ testTimeout: 120_000 })

const dockerfile = read("Dockerfile")
const manifest = json("package.json")
const volumeBins = ["/data/home/.npm-global/bin", "/data/home/.local/bin"]

let config: Config

beforeAll(async () => {
  await buildImage()
  config = inspect()
}, 900_000)

afterAll(cleanup, 120_000)

/** The packages dpkg holds as installed whose names match a pattern. */
const installed = (pattern: string) =>
  lines(
    "dpkg-query -W -f='${db:Status-Abbrev}${Package}\\n' | sed -n 's/^ii //p' | grep -xE '" +
      pattern +
      "'; true",
  )

/** The commands among these that the image's PATH holds. */
const onPath = (names: ReadonlyArray<string>, options?: Options) =>
  lines(
    "for name in " + names.join(" ") + '; do command -v "$name"; done; true',
    options,
  )

describe("what the image holds", () => {
  it("IMG-1 the base is node:26-trixie-slim pinned by digest, which is Debian and not Alpine, and Node is 26", () => {
    expect(dockerfile).toMatch(
      /^ARG NODE=docker\.io\/library\/node:26-trixie-slim@sha256:[0-9a-f]{64}$/m,
    )
    expect(dockerfile.match(/^FROM .*$/gm)).toEqual([
      "FROM ${UV} AS uv",
      "FROM ${NODE} AS build",
      "FROM ${NODE}",
    ])
    expect(
      lines('. /etc/os-release && echo "$ID $VERSION_CODENAME" && node -v'),
    ).toEqual(["debian trixie", expect.stringMatching(/^v26\./)])
  })

  it("IMG-3 the Debian packages are installed without the ones they recommend, and gh is GitHub's own package", () => {
    const packages = [
      "ca-certificates",
      "curl",
      "git",
      "jq",
      "openssh-client",
      "procps",
      "ripgrep",
      "sqlite3",
      "tini",
      "unzip",
      "xz-utils",
    ]
    expect(installed([...packages, "gh"].join("|")).toSorted()).toEqual(
      [...packages, "gh"].toSorted(),
    )
    // git recommends both of these, so an install that took recommended packages would hold them.
    expect(installed("less|patch")).toEqual([])
    expect(
      lines(
        "dpkg-query -W -f='${Maintainer}\\n' gh && cat /etc/apt/sources.list.d/github-cli.list",
      ),
    ).toEqual([
      expect.stringMatching(/^GitHub/),
      expect.stringMatching(
        / https:\/\/cli\.github\.com\/packages stable main$/,
      ),
    ])
  })

  it("IMG-4 MCP-44 uv and uvx are in the image at the pinned version beside Node's npx, and no Python package is", () => {
    const pinned = /^ARG UV=ghcr\.io\/astral-sh\/uv:(\d+\.\d+\.\d+)$/m.exec(
      dockerfile,
    )?.[1]
    expect(pinned).toBeDefined()
    expect(lines("uv --version && uvx --version && npx --version")).toEqual([
      expect.stringMatching(new RegExp("^uv " + pinned + "( |$)")),
      expect.stringMatching(new RegExp("^uvx " + pinned + "( |$)")),
      expect.stringMatching(/^\d+\.\d+\.\d+$/),
    ])
    expect(onPath(["uv", "uvx", "npx"])).toEqual([
      "/usr/local/bin/uv",
      "/usr/local/bin/uvx",
      "/usr/local/bin/npx",
    ])
    expect(installed("(lib)?python.*")).toEqual([])
    expect(onPath(["python", "python3"])).toEqual([])
  })

  it("IMG-5 node_modules carries TypeScript 7 and esbuild with its binary for the platform, and the image has no Python package and no compiler toolchain", () => {
    const [tsc, esbuild, binary, platform] = lines(
      "cd /opt/chad/node_modules && .bin/tsc --version && .bin/esbuild --version && ls -d .pnpm/@esbuild+*" +
        " && node -p 'process.platform + \"-\" + process.arch'",
    )
    expect(tsc).toMatch(/^Version 7\./)
    expect(tsc).toBe("Version " + manifest.dependencies.typescript)
    expect(esbuild).toBe(manifest.dependencies.esbuild)
    expect(binary).toBe(".pnpm/@esbuild+" + platform + "@" + esbuild)
    expect(
      output(
        "echo 'const one: number = 1' | /opt/chad/node_modules/.bin/esbuild --loader=ts",
      ),
    ).toBe("const one = 1;")
    expect(
      installed(
        "(lib)?python.*|gcc|gcc-[0-9]+|g\\+\\+.*|cpp.*|make|clang.*|build-essential|binutils.*|libc6-dev",
      ),
    ).toEqual([])
    expect(
      onPath(["python", "python3", "gcc", "cc", "g++", "c++", "make", "ld"]),
    ).toEqual([])
  })

  it("IMG-6 MOD-6 the JavaScript of the Claude agent SDK is in node_modules and the Claude Code binary is not", () => {
    const packages = lines(
      "cd /opt/chad/node_modules/.pnpm && ls -d @anthropic-ai+claude-agent-sdk*",
    )
    expect(packages).toEqual([
      expect.stringMatching(/^@anthropic-ai\+claude-agent-sdk@/),
    ])
    const sdk =
      "/opt/chad/node_modules/.pnpm/" +
      packages[0] +
      "/node_modules/@anthropic-ai/claude-agent-sdk"
    expect(
      lines(
        "ls " +
          sdk +
          "/*.mjs && node -p 'require(\"" +
          sdk +
          "/package.json\").name'",
      ),
    ).toEqual(
      expect.arrayContaining([
        sdk + "/sdk.mjs",
        "@anthropic-ai/claude-agent-sdk",
      ]),
    )
    // The binary is 349 MB, and nothing else in node_modules comes near it.
    expect(
      lines(
        "find /opt/chad/node_modules \\( -type f -size +100M \\) -o \\( -type f -name claude \\)",
      ),
    ).toEqual([])
  })

  it("IMG-7 clanka/ClaudeAgent imports in the image and no package of the platform binary is in node_modules", () => {
    expect(
      output(
        'cd /opt/chad && node --input-type=module -e \'await import("clanka/ClaudeAgent"); console.log("imports")\'',
      ),
    ).toBe("imports")
    expect(
      lines(
        "find /opt/chad/node_modules -name '@anthropic-ai+claude-agent-sdk-*' -o -path '*/@anthropic-ai/claude-agent-sdk-*' -prune",
      ),
    ).toEqual([])
  })

  it("IMG-8 no browser is in the image", () => {
    expect(installed(".*(chrom|firefox|webkit).*")).toEqual([])
    expect(
      lines(
        "find / -xdev \\( -iname 'chrom*' -o -iname '*firefox*' -o -iname '*webkit*' -o -iname '*playwright*'" +
          " -o -iname '*puppeteer*' -o -name headless_shell \\) 2>/dev/null; true",
      ),
    ).toEqual([])
  })

  it("IMG-56b LOAD-19 the image build counts the copies of effect, and the image's node_modules holds one", () => {
    const count =
      "find node_modules -name package.json -path '*/node_modules/effect/package.json' | wc -l"
    expect(dockerfile).toContain('RUN test "$(' + count + ')" = 1')
    expect(output("cd /opt/chad && " + count)).toBe("1")
  })
})

describe("the image's configuration", () => {
  it("IMG-10 the image exposes no port, keeps SIGTERM as its stop signal and declares no volume", () => {
    expect(config.ExposedPorts ?? {}).toEqual({})
    expect(config.Volumes ?? {}).toEqual({})
    expect(["", "SIGTERM"]).toContain(config.StopSignal ?? "")
    expect(dockerfile).not.toMatch(/^\s*(EXPOSE|STOPSIGNAL|VOLUME)\b/m)
  })

  it("IMG-13 IMG-14 CLI-1 the entrypoint is plain tini and the one chad executable by absolute path, in exec form, and the command is serve", () => {
    expect(config.Entrypoint).toEqual([
      "/usr/bin/tini",
      "--",
      "/usr/local/bin/chad",
    ])
    expect(config.Cmd).toEqual(["serve"])
    expect(
      lines(
        "which -a chad && readlink -f /usr/local/bin/chad && test -x /usr/bin/tini",
      ),
    ).toEqual(["/usr/local/bin/chad", "/opt/chad/bin/chad.js"])
  })

  it("IMG-18 the image runs as the node user, uid and gid 1000, and /data belongs to it", () => {
    expect(config.User).toBe("node")
    expect(lines("id -un && id -u && id -g && stat -c '%u %g' /data")).toEqual([
      "node",
      "1000",
      "1000",
      "1000 1000",
    ])
  })

  it("IMG-19 IMG-24 the image's variables have their fixed values, with the volume's bin directories at the end of PATH", () => {
    const path = [
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ...volumeBins,
    ].join(":")
    expect(config.Env).toEqual(
      expect.arrayContaining([
        "HOME=/data/home",
        "XDG_CACHE_HOME=/data/cache",
        "NPM_CONFIG_CACHE=/data/cache/npm",
        "NPM_CONFIG_PREFIX=/data/home/.npm-global",
        "PATH=" + path,
      ]),
    )
    expect(lines("npm config get prefix && echo $PATH")).toEqual([
      "/data/home/.npm-global",
      path,
    ])
  })

  it("IMG-31 the working directory is /data and HOME is /data/home", () => {
    expect(config.WorkingDir).toBe("/data")
    expect(lines("pwd && echo $HOME && echo ~")).toEqual([
      "/data",
      "/data/home",
      "/data/home",
    ])
  })

  it("IMG-79 the image's health check runs chad health every 30 s with a 5 s timeout, 3 retries, a 60 s start period and a 2 s start interval", () => {
    const second = 1_000_000_000
    expect(config.Healthcheck).toEqual({
      Test: ["CMD", "chad", "health"],
      Interval: 30 * second,
      Timeout: 5 * second,
      Retries: 3,
      StartPeriod: 60 * second,
      StartInterval: 2 * second,
    })
  })
})

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
  it("IMG-20 what is installed on the volume is there in the next container, and nothing there shadows a tool of the image", () => {
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

  it("IMG-21 a login shell has the two volume bin directories on PATH again, last and once", () => {
    const [login = [], again] = lines(
      "bash -lc 'echo $PATH; . /etc/profile.d/chad.sh; echo $PATH'",
    ).map((path) => path.split(":"))
    // /etc/profile gave the shell a PATH of its own, which is not the image's.
    expect(login).not.toContain("/usr/local/sbin")
    expect(login).toContain("/usr/bin")
    expect(login.slice(-2)).toEqual(volumeBins)
    expect(login.filter((entry) => volumeBins.includes(entry))).toEqual(
      volumeBins,
    )
    expect(again).toEqual(login)
  })

  it("IMG-22 the image's user has no sudo and cannot install with apt", () => {
    expect(onPath(["sudo", "doas"])).toEqual([])
    expect(sh("apt-get install -y hello")).toMatchObject({
      status: 100,
      stderr: expect.stringContaining("Permission denied"),
    })
    expect(sh("apt-get update").status).toBe(100)
  })

  it("IMG-37 MCP-45 the npm cache and the uv cache are under /data/cache, and an install caches nothing under home", () => {
    expect(
      lines(
        installGlobal +
          " && uv tool list --quiet && npm config get cache && uv cache dir && ls -A /data/cache /data/home",
      ),
    ).toEqual([
      "/data/cache/npm",
      "/data/cache/uv",
      "/data/cache:",
      "npm",
      "uv",
      "/data/home:",
      ".npm-global",
    ])
  })
})

/**
 * A preload for the image's chad. At exit it writes to standard error what the launcher imported, which of chad's
 * own built files were loaded and which package directories effect was loaded from.
 */
const trace = [
  'import { registerHooks } from "node:module"',
  "const launcher = []",
  "const dist = new Set()",
  "const effect = new Set()",
  "registerHooks({",
  "  resolve(specifier, context, next) {",
  '    if (context.parentURL === "file:///opt/chad/bin/chad.js") launcher.push(specifier)',
  "    return next(specifier, context)",
  "  },",
  "  load(url, context, next) {",
  '    if (url.startsWith("file:///opt/chad/dist/")) dist.add(url.slice(22))',
  '    const at = url.indexOf("/node_modules/effect/")',
  "    if (at !== -1) effect.add(url.slice(7, at + 20))",
  "    return next(url, context)",
  "  },",
  "})",
  'process.on("exit", () =>',
  '  process.stderr.write("trace " + JSON.stringify({ launcher, dist: [...dist], effect: [...effect] }) + "\\n"),',
  ")",
].join("\n")
const traced = [
  "--env",
  "NODE_OPTIONS=--import=data:text/javascript," + encodeURIComponent(trace),
]
const readTrace = (
  stderr: string,
): {
  readonly launcher: ReadonlyArray<string>
  readonly dist: ReadonlyArray<string>
  readonly effect: ReadonlyArray<string>
} =>
  JSON.parse(
    stderr
      .split("\n")
      .find((line) => line.startsWith("trace "))
      ?.slice(6) ?? "null",
  )

describe("the chad launcher", () => {
  it("IMG-16a IMG-16c LOAD-18 chad serve loads the daemon as separate files with the effect of node_modules, and the launcher sends any other command to the CLI bundle", async () => {
    expect(
      lines("head -n 1 /opt/chad/bin/chad.js && wc -l < /opt/chad/bin/chad.js"),
    ).toEqual(["#!/usr/bin/env node", expect.stringMatching(/^\d$/)])

    const container = start(...traced)
    await ready(container)
    expect(stop(container)).toBe(0)
    const serve = readTrace(logs(container).stderr)
    expect(serve.launcher).toEqual(["../dist/daemon.js"])
    expect(serve.dist).toEqual(
      expect.arrayContaining(["daemon.js", "daemon/runDaemon.js"]),
    )
    // Every module of effect came from the one package directory that plugins are given. A bundled copy would have
    // come from a file of chad's own.
    expect(serve.effect).toEqual([
      output("readlink -f /opt/chad/node_modules/effect"),
    ])

    // The CLI ran from the bundle: with no daemon in its container, `chad status` says so and exits 4.
    const status = command(traced, "status")
    expect(status.status).toBe(4)
    expect(status.stdout.split("\n")[0]).toBe(
      "daemon: not running (lock /data/state/daemon.lock is free)",
    )
    const other = readTrace(status.stderr)
    expect(other.launcher).toEqual(["../dist/cli.bundle.js"])
    expect(other.dist).not.toContain("daemon.js")
  })
})

describe("the image booted on an empty named volume, and then stopped", () => {
  let processes: ReadonlyArray<string>
  let directories: ReadonlyArray<string>
  let version: string
  let run: ReadonlyArray<string>
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
    run = exec(container, "ls -A /data/run").split("\n")
    exitCode = stop(container)
    stdout = logs(container).stdout
  })

  it("TST-29 the built image runs the real chad serve on an empty volume as uid 1000, and a stop ends it with exit code 0", () => {
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

  it("IMG-112 TST-52 the image carries the local adapter's client and no platform for it, and nothing is at run/local.sock", () => {
    expect(lines("ls /opt/chad/dist/daemon/LocalChat.js")).toEqual([
      "/opt/chad/dist/daemon/LocalChat.js",
    ])
    // The platform is effect's ChatTest behind an RPC server, in this repository's test support.
    expect(
      lines(
        "find /opt/chad -path /opt/chad/node_modules -prune -o -name 'test*' -print;" +
          " grep -rl ChatTest /opt/chad/bin /opt/chad/dist; true",
      ),
    ).toEqual([])
    expect(run).not.toContain("local.sock")
    expect(stdout).toMatch(/event=boot\.ready .*\bconnections=0\b/)
  })
})

describe("an owner's message to the image, with the local platform and the fake model server in a second container", () => {
  const reply = "Hello from the image."
  let data: string
  let shared: string
  let url: string
  let added: ReadonlyArray<Result>
  let sockets: { before: ReadonlyArray<string>; after: ReadonlyArray<string> }
  let health: string
  let answers: ReadonlyArray<string>
  let calls: ReadonlyArray<Model.Call>
  let status: ReadonlyArray<string>
  let daemon: Container
  let second: Container
  let id: string
  let kept: string

  /** A container's mounts, by where they are mounted. */
  const mounts = ({ Mounts }: Container) =>
    Mounts.toSorted((a, b) => a.Destination.localeCompare(b.Destination)).map(
      ({ Type, Name, Destination, RW }) =>
        Type === "volume"
          ? { Type, Name, Destination, RW }
          : { Type, Destination, RW },
    )

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
    const run = () => exec(daemonName, "ls -A /data/run").split("\n")
    kept = await scenario(
      { daemon: daemonName, fakes: fakesName },
      async (step) => {
        step("waiting for the daemon's boot.ready")
        await ready(daemonName)
        const before = run()
        step("starting the second container")
        const fakes = await startFakes(fakesName, shared, data)
        sockets = { before, after: run() }
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
        calls = await fakes.model.calls()
        step("running chad status in the daemon's container")
        status = exec(daemonName, "chad status").split("\n")
        daemon = container(daemonName)
        second = container(fakesName)
        id = imageId()
      },
    )
  }, 120_000)

  it("TST-58 TST-57 TST-210 the image answers an owner's message with the scripted model's text, on a local platform and a fake model server that a second container of the same image runs from one file mounted read-only, and the engine reports the daemon's container healthy", () => {
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

    // The second container is the same image under its default uid, on the daemon's volume and network.
    expect(second.Image).toBe(id)
    expect(second.Config.User).toBe(config.User)
    expect(Object.keys(second.NetworkSettings.Networks)).toEqual([shared])
    expect(mounts(second)).toEqual([
      { Type: "volume", Name: data, Destination: "/data", RW: true },
      { Type: "bind", Destination: fakesFile, RW: false },
    ])
    // What it runs is the one mounted file, which was bundled from this repository and is no part of the checkout.
    expect([second.Path, ...second.Args]).toEqual([
      "node",
      fakesFile,
      new URL(url).port,
    ])
    const file = second.Mounts.find(({ Type }) => Type === "bind")?.Source ?? ""
    expect(statSync(file).isFile()).toBe(true)
    expect(file.startsWith(root)).toBe(false)
  })

  it("TST-44 the daemon's container is on openai-compat and reaches the fake by an ordinary URL: it is given the three model variables, no certificate authority and no host entries", () => {
    const variables = new Map(
      daemon.Config.Env.map((entry): [string, string] => {
        const at = entry.indexOf("=")
        return [entry.slice(0, at), entry.slice(at + 1)]
      }),
    )
    const own = (config.Env ?? []).map((entry) => entry.split("=")[0])
    // What the container holds over the image's own environment. podman adds two variables of its own.
    expect(
      [...variables.keys()]
        .filter((name) => ![...own, "container", "HOSTNAME"].includes(name))
        .toSorted(),
    ).toEqual(["CHAD_MODEL", "CHAD_OPENAI_API_KEY", "CHAD_OPENAI_API_URL"])
    expect(variables.get("CHAD_MODEL")).toBe("openai-compat/fake")
    expect(variables.get("CHAD_OPENAI_API_URL")).toBe(url)
    expect(new URL(url).protocol).toBe("http:")
    expect(daemon.HostConfig.ExtraHosts ?? []).toEqual([])
    // The one file system it is given is the volume, so no certificate file reached it either.
    expect(daemon.Mounts.map(({ Destination }) => Destination)).toEqual([
      "/data",
    ])
    // The request arrived at the fake under the name the URL gave.
    expect(calls.map(({ path, headers }) => [path, headers["host"]])).toEqual([
      ["/v1/chat/completions", new URL(url).host],
    ])
  })

  it("TST-59 the product is unchanged: the daemon's container is the image as built, with its own entrypoint and command, the volume and the network and nothing of the tests, and the platform comes from the second container's file", () => {
    expect(daemon.Image).toBe(id)
    expect([daemon.Path, ...daemon.Args]).toEqual([
      ...(config.Entrypoint ?? []),
      ...(config.Cmd ?? []),
    ])
    expect(daemon.Config.User).toBe(config.User)
    expect(mounts(daemon)).toEqual([
      { Type: "volume", Name: data, Destination: "/data", RW: true },
    ])
    expect(Object.keys(daemon.NetworkSettings.Networks)).toEqual([shared])
    // Nothing listened at run/local.sock while the daemon's container was the only one.
    expect(sockets.before).not.toContain("local.sock")
    expect(sockets.after).toContain("local.sock")
  })

  it("TST-211 the two containers share an internal network and publish no port, and the scenario keeps what they wrote, the daemon's log and the database under the run id", () => {
    expect(internal(shared)).toBe(true)
    expect(
      [daemon, second].flatMap(({ NetworkSettings }) =>
        Object.keys(NetworkSettings.Ports ?? {}),
      ),
    ).toEqual([])
    expect(readdirSync(kept).toSorted()).toEqual([
      "daemon.log",
      "data",
      "fakes.log",
    ])
    for (const file of ["logs/chad.log", "db/chad.db"]) {
      expect(existsSync(join(kept, "data", file))).toBe(true)
    }
  })
})

describe("a boot the start-up check refuses", () => {
  const contents = (data: string) =>
    lines("find /data -mindepth 1", { flags: ["--volume", data + ":/data"] })

  it("IMG-58 a boot as uid 2000 on a fresh named volume exits 1, names uid 2000 and the owner uid 1000, and writes nothing", () => {
    const data = volume()
    const boot = command(["--user", "2000", "--volume", data + ":/data"])
    expect(boot.status).toBe(1)
    expect(boot.stdout).toMatch(
      /chad serve: cannot write \/data\. chad runs as uid 2000, gid \d+ and \/data is owned by uid 1000, gid 1000, mode 755\. Give the volume to uid 2000, for example: chown -R 2000:\d+ <volume>/,
    )
    expect(contents(data)).toEqual([])
  })

  it("IMG-58 a boot on a volume whose repo/ root made exits 1, names the owner uid 0 and uid 1000, and writes nothing", () => {
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

describe("effect's AGENTS.md and ai-docs", () => {
  /** The name and the hash of AGENTS.md and of each file under ai-docs/ in a directory. */
  const docs = (directory: string) =>
    "(cd " +
    directory +
    " && find AGENTS.md ai-docs -type f | LC_ALL=C sort | xargs sha256sum)"
  const snapshot =
    "mkdir /tmp/snapshot && tar -xzf /opt/chad/vendor/effect.tgz -C /tmp/snapshot && " +
    docs("/tmp/snapshot/package")
  const effect = "/opt/chad/node_modules/effect"

  it("SELF-27 SELF-135 when the effect package lacks them the build makes them from effect's source at the manifest's commit, and it fails when it cannot", () => {
    const [vendored, produced] = output(
      [
        snapshot,
        "rm -rf " + effect + "/AGENTS.md " + effect + "/ai-docs",
        "sh /opt/effect-docs.sh >&2",
        "echo ==",
        docs(effect),
      ].join(" && "),
      { image: buildStage },
    ).split("\n==\n")
    expect(vendored?.split("\n").length).toBeGreaterThan(1)
    expect(produced).toBe(vendored)

    // A commit that effect's repository does not hold. The step has no other source to turn to.
    const nowhere = "0".repeat(40)
    const failed = sh(
      [
        "rm " + effect + "/AGENTS.md",
        'sed -i \'s/"commit": "[0-9a-f]*"/"commit": "' +
          nowhere +
          "\"/' /opt/chad/vendor/manifest.json",
        "sh /opt/effect-docs.sh",
      ].join(" && "),
      { image: buildStage },
    )
    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain(
      json("vendor/manifest.json").repository + "/tar.gz/" + nowhere,
    )
  })

  it("SELF-28 the image's AGENTS.md and ai-docs are the ones of the vendored snapshot, file for file", () => {
    const vendored = output(snapshot, { image: buildStage })
    expect(vendored).toContain("  AGENTS.md\n")
    expect(vendored).toContain("  ai-docs/src/")
    expect(output(docs(effect))).toBe(vendored)
  })
})
