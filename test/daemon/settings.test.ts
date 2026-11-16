// chad.json as the owner and the agent reach it: a plugin's settings with `${NAME}` from the secret store and process
// env, what check, apply and status list, the reload a settings change makes, a plugin turned off, safe mode's one read
// of the file, and a boot that ignores what does not fit.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { expect, onTestFinished, test, vi } from "vitest"
import { bundled } from "../../dist/Bundled.js"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import { applied, write } from "../support/applied.ts"
import { fresh, scenario, type Scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { eventually, says } from "../support/owner.ts"

const secret = "s3cret-value-9f2c"

/**
 * A bundled plugin that reads `token` and `greeting` while it loads and `url` only when its tool `probe` is called,
 * which also tries a key that only process env has. `builds` counts its loads.
 */
const probe = () => {
  const state = { builds: 0 }
  const Probe = Tool.make("probe", {
    description: "Reports what the plugin's settings hold.",
    parameters: Schema.Struct({}),
    success: Schema.String,
  })
  const Probes = Toolkit.make(Probe)
  const plugin = Plugin.make(
    Layer.unwrap(
      Effect.gen(function* () {
        const token = yield* Config.option(Config.Redacted("token"))
        yield* Config.String("greeting").pipe(Config.withDefault("Hello"))
        state.builds++
        return Plugin.toolkit(Probes).pipe(
          Layer.provide(
            Probes.toLayer({
              probe: () =>
                Effect.gen(function* () {
                  const url = yield* Config.String("url").pipe(
                    Config.withDefault("none"),
                  )
                  const home = yield* Config.option(Config.String("HOME"))
                  return `url=${url} token=${Option.isSome(token) && Redacted.value(token.value) === secret} home=${Option.isSome(home)}`
                }).pipe(Effect.orDie),
            }),
          ),
        )
      }),
    ),
  )
  return { state, plugin }
}

/** Runs one turn whose script calls `probe`, and gives what the script printed. */
const call = async (running: Scenario, text: string) => {
  const thread = await running.fakes.chat.makeThread("direct")
  const ended = running
    .log()
    .filter((line) => line.annotations["event"] === "turn.ended").length
  await running.fakes.model.script([
    runs("console.log(await probe({}))"),
    { text: "done" },
  ])
  await says(running, thread, text)
  await eventually(
    () =>
      running.log().filter((line) => line.annotations["event"] === "turn.ended")
        .length,
    (count) => count > ended,
  )
  return (results((await running.fakes.model.calls())[1]).at(-1) ?? "").trim()
}

const chadJson = (plugins: object) =>
  JSON.stringify({ plugins }, null, 2) + "\n"

test("SET-11 SET-12 SET-14 SET-19 SET-20 SET-21 SET-22 SET-23 SET-35 SET-62 SET-63 SET-66 SET-70 SET-72 SET-83 SET-94 SET-100 API-25 API-26 API-27 LOAD-50 LOAD-52 LOAD-88 SWAP-41 CLI-67 CLI-88 CLI-172 a bundled plugin's settings expand from the secret store and process env, are listed with no value, rebuild it only when they change, and turn it off", async () => {
  const { state, plugin } = probe()
  process.env["PROBE_HOST"] = "envhost"
  onTestFinished(() => {
    delete process.env["PROBE_HOST"]
  })
  const running = await scenario({ plugins: [{ name: "probe", plugin }] })
  mkdirSync(join(running.data, "secrets"), { recursive: true })
  writeFileSync(
    join(running.data, "secrets/secrets.json"),
    JSON.stringify({
      PROBE_TOKEN: { value: secret, date: "2026-11-16T00:00:00.000Z" },
    }),
  )
  const work = join(running.data, "repo/work")
  await eventually(
    () => state.builds,
    (builds) => builds === 1,
  )

  // A check lists what the plugin read while loading and warns about a key it did not, with no value.
  write(work, {
    "chad.json": chadJson({
      probe: {
        settings: {
          url: "http://${PROBE_HOST}:${PROBE_PORT:-7720}",
          token: "${PROBE_TOKEN}",
          tokn: "typo",
        },
      },
    }),
  })
  const listing = Messages.settingsListing(
    "probe",
    [
      { key: "token", sources: [{ from: "store", name: "PROBE_TOKEN" }] },
      { key: "greeting", sources: [{ from: "default" }] },
    ],
    ["url", "tokn"],
  )
  const checked = await running.chad(["check"])
  expect(checked).toMatchObject({
    code: 0,
    stdout: [...listing, Messages.checkPassed, ""].join("\n"),
  })
  const apply = await running.chad(["apply", "-m", "Settings"])
  expect(apply.code).toBe(0)
  expect(apply.stdout).toContain(listing.join("\n"))
  expect(state.builds).toBe(3)
  // The store's value reached the plugin and never process env.
  expect(process.env["PROBE_TOKEN"]).toBeUndefined()

  // A read at call time sees the expanded settings and nothing from process env.
  expect(await call(running, "probe")).toBe(
    "url=http://envhost:7720 token=true home=false",
  )
  const status = await running.chad(["status", "--json"])
  const report = JSON.parse(status.stdout) as {
    readonly plugins: ReadonlyArray<{
      readonly name: string
      readonly settings: ReadonlyArray<unknown>
    }>
  }
  expect(report.plugins.find(({ name }) => name === "probe")?.settings).toEqual(
    [
      {
        key: "token",
        sources: [{ from: "store", name: "PROBE_TOKEN" }],
        at: "load",
      },
      { key: "greeting", sources: [{ from: "default" }], at: "load" },
      {
        key: "url",
        sources: [
          { from: "file" },
          { from: "env", name: "PROBE_HOST" },
          { from: "inline", name: "PROBE_PORT" },
        ],
        at: "call",
      },
      { key: "HOME", sources: [{ from: "default" }], at: "call" },
    ],
  )
  const text = await running.chad(["status"])
  for (const output of [checked, apply, status, text]) {
    expect(output.stdout + output.stderr).not.toContain(secret)
    expect(output.stdout + output.stderr).not.toContain("envhost")
  }

  // A change elsewhere leaves the plugin running, and settings that differ only in key order are the same.
  write(work, {
    "persona.md": "Be brief.\n",
    "chad.json": chadJson({
      probe: {
        settings: {
          tokn: "typo",
          token: "${PROBE_TOKEN}",
          url: "http://${PROBE_HOST}:${PROBE_PORT:-7720}",
        },
      },
    }),
  })
  expect((await running.chad(["apply", "-m", "Persona"])).code).toBe(0)
  expect(state.builds).toBe(3)

  // A name that resolves nowhere fails the apply and names it, and the running version stays.
  write(work, {
    "chad.json": chadJson({ probe: { settings: { token: "${NOWHERE}" } } }),
  })
  const refused = await running.chad(["apply", "-m", "Missing"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(Messages.settingUnresolved("NOWHERE"))
  expect(await call(running, "probe again")).toBe(
    "url=http://envhost:7720 token=true home=false",
  )

  // Off unloads it, its unresolvable settings are not expanded, and a reload refuses it.
  write(work, {
    "chad.json": chadJson({
      probe: { enabled: false, settings: { token: "${NOWHERE}" } },
    }),
  })
  const off = await running.chad(["apply", "-m", "Off"])
  expect(off.code).toBe(0)
  expect((await running.chad(["status"])).stdout).toContain(
    "plugin: probe, off",
  )
  expect(await running.chad(["plugin", "reload", "probe"])).toMatchObject({
    code: 1,
    stderr: Messages.reloadOff("probe") + "\n",
  })
  expect(state.builds).toBe(3)
})

test("SET-44 SET-46 SET-47 SET-48 SET-86 REC-52 REC-53 REC-63 SWAP-58 CLI-72 LOAD-63 in safe mode the bundled plugins build on their defaults, one the applied chad.json turns off stays off, and an apply that flips it takes effect at once", async () => {
  // A previous boot's repo must work without a developer's global Git identity, as on the gate.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null")
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ])
    vi.stubEnv(key, undefined)
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  const names = bundled.map(({ name }) => name)
  const { state, plugin } = probe()
  const directory = fresh()
  applied(join(directory, "data/repo"), {
    "chad.json": chadJson({
      probe: { enabled: false },
      ...Object.fromEntries(names.map((name) => [name, { enabled: "yes" }])),
    }),
    "persona.md": "",
  })
  const running = await scenario({
    directory,
    plugins: [...bundled, { name: "probe", plugin }],
    env: { CHAD_SAFE_MODE: "1" },
  })
  const status = async () =>
    JSON.parse((await running.chad(["status", "--json"])).stdout) as {
      readonly plugins: ReadonlyArray<{ readonly name: string }>
      readonly skipped: ReadonlyArray<unknown>
    }
  // Every bundled plugin builds with no entry of its own, and a bad `enabled` turns on only that plugin.
  expect(
    await eventually(status, (report) => report.plugins !== undefined),
  ).toMatchObject({
    plugins: names.sort().map((name) => ({ name })),
    skipped: [],
  })
  expect(state.builds).toBe(0)

  const work = join(running.data, "repo/work")
  write(work, { "chad.json": chadJson({ probe: { settings: { a: 1 } } }) })
  const on = await running.chad(["apply", "-m", "Probe on"])
  expect(on.code, on.stderr).toBe(0)
  expect(state.builds).toBe(1)
  expect(await call(running, "probe")).toBe("url=none token=false home=false")

  write(work, { "chad.json": chadJson({ probe: { enabled: false } }) })
  expect((await running.chad(["apply", "-m", "Probe off"])).code).toBe(0)
  expect((await status()).plugins.map(({ name }) => name)).toEqual(names.sort())
})

test("SET-57 SET-58 SET-59 SET-60 SET-90 SET-97 REC-43 REC-46 FAIL-164 FAIL-236 FAIL-270 FAIL-271 a boot uses what fits in the applied chad.json, skips the plugin whose name resolves nowhere, and lists what it ignored under Problems", async () => {
  const one = probe()
  const two = probe()
  const directory = fresh()
  applied(join(directory, "data/repo"), {
    "chad.json": chadJson({
      one: { settings: { token: "${NOWHERE}" }, extra: true },
      two: { enabled: "no", settings: { token: "${NOWHERE}" } },
      gone: {},
    }),
    "persona.md": "",
  })
  const running = await scenario({
    directory,
    plugins: [
      { name: "one", plugin: one.plugin },
      { name: "two", plugin: two.plugin },
    ],
  })
  await eventually(
    () => two.state.builds,
    (builds) => builds === 1,
  )
  const status = await eventually(
    async () => (await running.chad(["status"])).stdout,
    (text) => text.includes("plugin: one, skipped"),
  )
  expect(one.state.builds).toBe(0)
  expect(status).toContain(
    Messages.settingsIgnored([
      "plugins.one.extra",
      "plugins.two",
      "plugins.gone",
    ]),
  )
  expect(running.log().map((line) => line.annotations["event"])).toContain(
    "settings.ignored",
  )
})
