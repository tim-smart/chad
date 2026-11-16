import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, References } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as Image from "../../scripts/image.ts"
import { dockerfileNode, nodeProblem } from "../../scripts/local.ts"
import * as Vendor from "../../scripts/vendor.ts"
import * as Environment from "../../src/daemon/Environment.ts"
import * as Logger from "../../src/daemon/Logger.ts"
import type { DaemonInputs } from "../../src/daemon/runDaemon.ts"
import * as Storage from "../../src/daemon/Storage.ts"
import * as Volume from "../../src/daemon/Volume.ts"
import { events, levelOf } from "../../src/Events.ts"
import { defaults, scale, type Timings } from "../../src/Timings.ts"
import config, { files, timezone } from "../../vitest.config.ts"
import { factor } from "../support/factor.ts"
import { json, path, read, yaml } from "../support/repo.ts"

/** One step of a workflow job. */
interface Step {
  readonly if?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: Record<string, unknown>
}

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(path(directory), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(directory, file))

describe("the durations", () => {
  const seconds = (length: Duration.Duration) =>
    Duration.toMillis(length) / 1000

  it("TST-70 TST-71 STO-36 SES-126 CLI-152 IMG-116 each default of Timings is the value of the durations table", () => {
    const { pruneAt, turnTimeout, ...lengths } = defaults
    expect(
      Object.fromEntries(
        Object.entries(lengths).map(([name, length]) => [
          name,
          seconds(length),
        ]),
      ),
    ).toEqual({
      swapDrain: 30,
      swapInterruptWait: 1,
      swapClose: 10,
      hookPromptChunk: 2,
      hookBeforeTurn: 5,
      hookAfterTurn: 30,
      hookOnSession: 10,
      pluginBuild: 30,
      stopRequests: 15,
      stopHooksUntil: 50,
      stopDeadline: 60,
      modelLogin: 15 * 60,
      modelTrial: 60,
      sessionIdle: 30 * 60,
      messagePoll: 1,
      messageRetention: 24 * 3600,
      catchUpWindow: 7 * 24 * 3600,
      statusEditInterval: 2,
      healthPing: 2,
      cliAnswer: 2,
      lockBusy: 3,
      freeSpaceInterval: 3600,
      pruneAge: 30 * 24 * 3600,
      noticeQuiet: 24 * 3600,
      statusFailedWindow: 24 * 3600,
      statusTokenWindow: 7 * 24 * 3600,
    })
    expect(pruneAt).toBe("0 4 * * *")
    // clanka's turn timeout is not chad's to set, and clanka keeps its default (FAIL-79, TST-215).
    expect(turnTimeout).toBeUndefined()
    // The longest wait of a turn that starts during a swap has no value of its own.
    expect(seconds(defaults.swapDrain) + seconds(defaults.swapClose)).toBe(40)
  })

  it("TST-73 TST-75 the test entry shortens every length by one factor, which keeps the orderings and leaves the prune's time of day alone", () => {
    expect(factor).toBeLessThan(1)
    const scaled = scale(defaults, factor)
    const names = Object.keys(defaults).filter(
      (name) => name !== "pruneAt" && name !== "turnTimeout",
    ) as ReadonlyArray<Exclude<keyof Timings, "pruneAt" | "turnTimeout">>
    for (const name of names) {
      expect(Duration.toMillis(scaled[name])).toBeCloseTo(
        Duration.toMillis(defaults[name]) * factor,
      )
    }
    expect(scaled.pruneAt).toEqual(defaults.pruneAt)
    expect(seconds(scaled.swapDrain)).toBeGreaterThan(seconds(scaled.swapClose))
    expect(seconds(scaled.stopRequests)).toBeLessThan(
      seconds(scaled.stopHooksUntil),
    )
    expect(seconds(scaled.stopHooksUntil)).toBeLessThan(
      seconds(scaled.stopDeadline),
    )
  })

  it("TST-33 TST-201 TST-202 TST-217 runDaemon takes the four inputs of the table, the plugins and the bundled skills, and no other", () => {
    // The type-check fails on a key that is missing here or that DaemonInputs does not have.
    const inputs: Record<keyof DaemonInputs, true> = {
      chat: true,
      httpClient: true,
      webSocketConstructor: true,
      timings: true,
      plugins: true,
      skills: true,
    }
    expect(Object.keys(inputs)).toHaveLength(6)
    const serve = read("src/daemon.ts")
    for (const name of Object.keys(inputs)) {
      expect(serve).toMatch(new RegExp(`^  ${name}: `, "m"))
    }
  })

  it("TST-72 OV-42 chad serve passes the defaults, and nothing the daemon reads from the environment is a duration", () => {
    const serve = read("src/daemon.ts")
    expect(serve).toContain("timings: defaults")
    expect(serve).toContain("runDaemon(")
    expect(Object.keys(Environment.read({})).sort()).toEqual([
      "data",
      "installs",
      "logLevel",
      "model",
      "openaiApiKey",
      "openaiApiUrl",
      "safeMode",
      "socket",
      "tz",
      "unknownLogLevel",
      "variables",
    ])
    // Each side reads the environment in one place, and one module each holds the durations and the messages.
    const readers = sources("src").filter((file) =>
      /process\.env\b(?!\["CHAD_SESSION"\])/.test(read(file)),
    )
    expect(readers).toEqual(["src/cli/runCli.ts", "src/daemon/runDaemon.ts"])
    const top = readdirSync(path("src"))
    expect(top).toContain("Timings.ts")
    expect(top).toContain("Messages.ts")
  })
})

describe("the logger", () => {
  it("FAIL-8 FAIL-189 FAIL-240 the event names are the closed list of the spec's table, each area.name with one dot", () => {
    const table = [
      ...read("docs/spec/16-failures-logs-status.md").matchAll(
        /^\| \*\*FAIL-\d+\*\* \| `([^`]+)` \|/gm,
      ),
    ].map((row) => row[1])
    expect(Object.keys(events).sort()).toEqual([...table].sort())
    for (const name of Object.keys(events)) {
      expect(name).toMatch(/^[a-z]+(-[a-z]+)*\.[a-z]+(-[a-z]+)*$/)
    }
    // The one level of this slice that depends on the reason.
    expect(levelOf("message.ignored", "not-owner")).toBe("Info")
    expect(levelOf("message.ignored", "own")).toBe("Debug")
  })

  it("FAIL-17 FAIL-18 CHAD_LOG_LEVEL takes its eight values in any letter case, info is the default, and any other value is unknown", () => {
    const level = (value?: string) =>
      Environment.read(value === undefined ? {} : { CHAD_LOG_LEVEL: value })
    expect(level().logLevel).toBe("Info")
    expect(
      ["all", "trace", "debug", "info", "warn", "error", "fatal", "none"].map(
        (value) => level(value).logLevel,
      ),
    ).toEqual([
      "All",
      "Trace",
      "Debug",
      "Info",
      "Warn",
      "Error",
      "Fatal",
      "None",
    ])
    expect(level("WARN")).toMatchObject({ logLevel: "Warn" })
    expect(level("Debug").unknownLogLevel).toBeUndefined()
    // A name that every object inherits is no level either.
    for (const value of ["loud", "constructor", "__proto__", "toString", ""]) {
      expect(level(value)).toMatchObject({
        logLevel: "Info",
        unknownLogLevel: value,
      })
    }
  })

  it("FAIL-20 effect's minimum is the more verbose of Info and the level, and the sinks drop what a quieter level leaves out", async () => {
    const run = (level: Environment.Environment["logLevel"]) => {
      const printed: Array<string> = []
      return Effect.gen(function* () {
        yield* Effect.logDebug("debug")
        yield* Effect.logInfo("info")
        yield* Effect.logWarning("warn")
        return {
          minimum: yield* References.MinimumLogLevel,
          printed: printed.map((line) => / message=(\w+)/.exec(line)?.[1]),
        }
      }).pipe(
        Effect.provide(
          Logger.layer({
            level,
            file: Logger.makeFileSink(),
            stdout: (line) => printed.push(line),
          }),
        ),
        Effect.runPromise,
      )
    }
    expect(await run("Info")).toEqual({
      minimum: "Info",
      printed: ["info", "warn"],
    })
    expect(await run("Warn")).toEqual({ minimum: "Info", printed: ["warn"] })
    expect(await run("None")).toEqual({ minimum: "Info", printed: [] })
    expect(await run("Debug")).toEqual({
      minimum: "Debug",
      printed: ["debug", "info", "warn"],
    })
  })
})

describe("storage", () => {
  it("STO-33 the one connection has the driver's 5 second busy timeout", async () => {
    const data = mkdtempSync(join(tmpdir(), "chad-unit-"))
    try {
      mkdirSync(join(data, "db"))
      const rows = await Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`PRAGMA busy_timeout`
      }).pipe(
        Effect.provide(Storage.layer(Volume.make(data))),
        Effect.runPromise,
      )
      expect(rows).toEqual([{ timeout: 5000 }])
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })

  it("STO-39 STO-187 the migrations only go forward, one file for each, and a delivered one is as it was delivered", () => {
    const delivered: Record<string, string> = json(
      "test/unit/fixtures/migrations.json",
    )
    const directory = "src/daemon/migrations"
    const names = readdirSync(path(directory)).sort()
    expect(names.map((name) => name.replace(/\.ts$/, ""))).toEqual(
      Object.keys(Storage.migrations),
    )
    for (const name of names) {
      expect(read(join(directory, name))).not.toMatch(/\bdown\b|DROP TABLE/i)
    }
    // A delivered migration keeps the hash it was delivered with. A new one is added to the fixture by its slice.
    const hashes = Object.fromEntries(
      names.map((name) => [
        name,
        createHash("sha256")
          .update(read(join(directory, name)))
          .digest("hex"),
      ]),
    )
    expect(hashes).toEqual(delivered)
  })
})

describe("the suite", () => {
  it("TST-3 TST-77 TST-79 each layer is a project on forks, the files run at once are the core count, and the timezone is Pacific/Auckland", () => {
    for (const project of config.test?.projects ?? []) {
      expect(project).toMatchObject({
        test: { pool: "forks", env: { TZ: "Pacific/Auckland" } },
      })
    }
    expect(files).toBe(availableParallelism())
    expect(config.test?.maxWorkers).toBe(files)
    expect(timezone).toBe("Pacific/Auckland")
    expect(process.env["TZ"]).toBe(timezone)
  })

  it("TST-4 the repository holds no shell check script", () => {
    const tracked = spawnSync(
      "git",
      ["ls-files", "-co", "--exclude-standard"],
      {
        cwd: path(""),
        encoding: "utf8",
      },
    ).stdout.split("\n")
    expect(tracked.length).toBeGreaterThan(10)
    expect(tracked.filter((file) => /\.(sh|bash)$/.test(file))).toEqual([])
  })

  it("TST-76 no scenario waits a fixed time", () => {
    for (const file of [
      ...sources("test/daemon"),
      ...sources("test/process"),
    ]) {
      expect(read(file), file).not.toMatch(/setTimeout|sleep\(|within \d+/)
    }
  })

  it("TST-5a TST-135 CI runs the Node major the Dockerfile names, and the local command fails at once on another", () => {
    const dockerfile = read("Dockerfile")
    const major = dockerfileNode(dockerfile)
    const jobs: Record<string, { steps: ReadonlyArray<Step> }> = yaml(
      ".github/workflows/gate.yml",
    ).jobs
    for (const job of Object.values(jobs)) {
      const setup = job.steps.find((step) =>
        String(step.uses).startsWith("actions/setup-node@"),
      )
      expect(String(setup?.with?.["node-version"])).toBe(major)
    }
    expect(nodeProblem(dockerfile, `v${major}.1.0`)).toBeUndefined()
    expect(nodeProblem(dockerfile, "v25.9.0")).toBe(
      `Node v25.9.0 is running and the Dockerfile names Node ${major}`,
    )
    // The check comes before the layers run.
    const local = read("scripts/local.ts")
    expect(local.indexOf("nodeProblem(")).toBeLessThan(
      local.lastIndexOf("vitest.mjs"),
    )
  })

  it("TST-136 a second command runs the image layer, on Docker or on podman", () => {
    expect(json("package.json").scripts["test:image"]).toBe(
      "node scripts/image.ts",
    )
    expect(Image.pick(undefined, () => true)).toBe("docker")
    expect(Image.pick(undefined, (engine) => engine === "podman")).toBe(
      "podman",
    )
    expect(Image.pick("podman", () => true)).toBe("podman")
    expect(read("test/support/image.ts")).toContain("CHAD_ENGINE")
  })
})

describe("the dependencies", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "chad-vendor-"))
    mkdirSync(join(root, "vendor"))
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'catalog:\n  effect: file:vendor/effect.tgz\n  "@effect/vitest": file:vendor/effect-vitest.tgz\n',
    )
    writeFileSync(join(root, "pnpm-lock.yaml"), "old lock")
    writeFileSync(join(root, "vendor/effect.tgz"), "old effect")
    writeFileSync(join(root, "vendor/effect-vitest.tgz"), "old vitest")
    writeFileSync(
      join(root, "vendor/manifest.json"),
      JSON.stringify({ repository: "Effect-TS/effect", commit: "old" }),
    )
    const state = () => ({
      effect: readFileSync(join(root, "vendor/effect.tgz"), "utf8"),
      vitest: readFileSync(join(root, "vendor/effect-vitest.tgz"), "utf8"),
      commit: JSON.parse(
        readFileSync(join(root, "vendor/manifest.json"), "utf8"),
      ).commit,
      lock: readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    })
    return { root, state }
  }
  const target = { commit: "new", commitDate: "2026-11-15T00:00:00Z" }
  const steps = (scenario: boolean, root: string): Vendor.Steps => ({
    download: async (url) => new TextEncoder().encode(url),
    install: () => {
      writeFileSync(join(root, "pnpm-lock.yaml"), "new lock")
      return true
    },
    scenario: () => scenario,
  })

  it("IMG-119 one script replaces the vendored tarballs as a set, from pkg.pr.new, and a failed download leaves the old set", async () => {
    const { root, state } = fixture()
    try {
      const failing: Vendor.Steps = {
        ...steps(true, root),
        download: async (url) => {
          if (url.includes("@effect/vitest")) throw new Error("not published")
          return new TextEncoder().encode(url)
        },
      }
      await expect(Vendor.replace(root, target, failing)).rejects.toThrow(
        "not published",
      )
      expect(state()).toMatchObject({ effect: "old effect", commit: "old" })

      expect(await Vendor.replace(root, target, steps(true, root))).toBe(true)
      expect(state()).toEqual({
        effect: "https://pkg.pr.new/Effect-TS/effect/effect@new",
        vitest: "https://pkg.pr.new/Effect-TS/effect/@effect/vitest@new",
        commit: "new",
        lock: "new lock",
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // An upgrade is done by hand with the script, and each of its command lines is read as written.
    expect(Vendor.request(["e1ae842"])).toEqual({
      commit: "e1ae842",
      clanka: undefined,
    })
    expect(Vendor.request(["--clanka", "0.28.0", "e1ae842"])).toEqual({
      commit: "e1ae842",
      clanka: "0.28.0",
    })
    expect(Vendor.request(["--newest", "--clanka", "newest"])).toEqual({
      commit: undefined,
      clanka: "newest",
    })
    expect(Vendor.request([])).toBeUndefined()
    expect(Vendor.request(["--clanka", "newest"])).toBeUndefined()
    expect(json("package.json").scripts.vendor).toBe("node scripts/vendor.ts")
  })

  it("TST-185 a newer snapshot that fails the scenario of a message in and a scripted answer out is taken back out", async () => {
    const { root, state } = fixture()
    try {
      expect(await Vendor.replace(root, target, steps(false, root))).toBe(false)
      expect(state()).toMatchObject({
        effect: "old effect",
        vitest: "old vitest",
        commit: "old",
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    expect(read("scripts/vendor.ts")).toMatch(
      /"test\/daemon\/turn\.test\.ts",\s*"-t",\s*"TST-164"/,
    )
  })

  it("IMG-2 Renovate bumps the digest that the Dockerfile pins", () => {
    const renovate = json("renovate.json")
    expect(renovate.enabledManagers).toEqual(["dockerfile"])
    expect(renovate.packageRules).toContainEqual({
      matchManagers: ["dockerfile"],
      pinDigests: true,
    })
    expect(read("Dockerfile")).toMatch(
      /^ARG NODE=\S+\/node:26-trixie-slim@sha256:[0-9a-f]{64}$/m,
    )
  })
})

describe("what chad ships", () => {
  it("TST-53 chad ships no interactive chat client, and the script that types into the local platform is outside the package", () => {
    const pkg = json("package.json")
    expect(pkg.bin).toEqual({ chad: "./bin/chad.js" })
    expect(
      sources("src").filter((file) => /readline/.test(read(file))),
    ).toEqual([])
    expect(read("scripts/local-chat.ts")).toContain("readline")
  })

  it("CRED-62 nothing sets clanka's scriptTimeout", () => {
    expect(
      sources("src").filter((file) => read(file).includes("scriptTimeout")),
    ).toEqual([])
  })

  it("SES-124 TST-69 the docs say, where they describe owners, that a webhook id on the list makes everyone who holds the webhook URL an owner", () => {
    expect(read("docs/owners.md").replace(/\s+/g, " ")).toContain(
      "A webhook id on the list makes everyone who holds the webhook URL an owner.",
    )
  })
})
