// chad.json as pure code: the expander against clanka's, the apply's checks and the boot's lenient read, and the
// provider that records what a plugin reads (docs/spec/11-settings.md).
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as McpConfig from "clanka/McpConfig"
import { Config, ConfigProvider, Effect, Option, Schema } from "effect"
import { expect, it } from "vitest"
import * as Messages from "../../src/Messages.ts"
import * as Settings from "../../src/Settings.ts"

const variables: Record<string, string> = {
  A: "alpha",
  B: "beta",
  EMPTY: "",
  lower_case: "low",
}

/** The strings both expanders read, each a case of SET-28 to SET-30 and SET-32. */
const strings = [
  "plain",
  "${A}",
  "x${A}y${B}z",
  "${MISSING}",
  "${MISSING:-fallback}",
  "${EMPTY:-fallback}",
  "${EMPTY}",
  "${A:-}",
  "${MISSING:-}",
  "${CHAD_DOLLAR:-$}{X}",
  "${A:-a}b}",
  "$A and ${1BAD}",
  "${lower_case}",
  "${A:-${B}}",
]

/** What clanka's `McpConfig.load` makes of a string as an http server's url: the text, or the name it missed. */
const clanka = async (text: string) => {
  const directory = mkdtempSync(join(tmpdir(), "chad-settings-"))
  writeFileSync(
    join(directory, ".mcp.json"),
    JSON.stringify({ mcpServers: { probe: { type: "http", url: text } } }),
  )
  const servers = await Effect.runPromise(
    McpConfig.load({ cwd: directory, files: [], enabled: true }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ...variables,
          XDG_CONFIG_HOME: directory,
        }),
      ),
    ),
  )
  const server = servers["probe"] as
    | { readonly type: "http"; readonly url: string }
    | { readonly type: "unavailable"; readonly error: string }
  return server.type === "http"
    ? { text: server.url }
    : { missing: server.error.split(" ")[2] }
}

const chad = async (text: string) => {
  const result = await Effect.runPromise(
    Effect.result(
      Settings.expandString(text, (name) =>
        Effect.succeed(
          Object.hasOwn(variables, name) && variables[name] !== ""
            ? Option.some({ value: variables[name]!, from: "env" as const })
            : Option.none(),
        ),
      ),
    ),
  )
  return result._tag === "Success"
    ? { text: result.success.text }
    : { missing: result.failure.variable }
}

it("SET-31 SET-27 SET-28 SET-29 SET-30 SET-32 chad's expander gives what clanka's McpConfig.load gives for the same strings", async () => {
  for (const text of strings) {
    expect({ text, ...(await chad(text)) }).toEqual({
      text,
      ...(await clanka(text)),
    })
  }
  expect(await chad("${CHAD_DOLLAR:-$}{X}")).toEqual({ text: "${X}" })
})

it("SET-76 SET-49 SET-50 SET-51 SET-52 SET-53 SET-87 SET-88 SET-89 the apply's checks of chad.json refuse each broken rule and pass a good file", () => {
  const known = new Set(["asphodel", "cron"])
  const good = JSON.stringify({
    plugins: {
      asphodel: { settings: { url: "http://a", token: "${T}" } },
      cron: { enabled: false },
    },
  })
  expect(Settings.validate(good, known)).toEqual({
    file: {
      plugins: {
        asphodel: { settings: { url: "http://a", token: "${T}" } },
        cron: { enabled: false },
      },
    },
    errors: [],
  })
  expect(Settings.validate(undefined, known).errors).toEqual([])
  const errors = (value: unknown) =>
    Settings.validate(
      typeof value === "string" ? value : JSON.stringify(value),
      known,
    ).errors
  expect(errors("{ nope")).toHaveLength(1)
  expect(errors([1])).toEqual([Messages.settingsNotObject])
  expect(errors({ plugins: {}, model: "x" })).toEqual([
    Messages.settingsTopKey("model"),
  ])
  expect(errors({ plugins: [] })).toEqual([Messages.settingsPluginsNotObject])
  expect(errors({ plugins: { cron: "off" } })).toEqual([
    Messages.settingsEntryNotObject("cron"),
  ])
  expect(errors({ plugins: { cron: { enabled: false, timers: 1 } } })).toEqual([
    Messages.settingsEntryKey("cron", "timers"),
  ])
  expect(errors({ plugins: { cron: { enabled: "no" } } })).toEqual([
    Messages.settingsEnabled("cron"),
  ])
  expect(errors({ plugins: { cron: { settings: [] } } })).toEqual([
    Messages.settingsSettings("cron"),
  ])
  expect(errors({ plugins: { crom: {} } })).toEqual([
    Messages.settingsUnknownPlugin("crom"),
  ])
})

it("SET-57 SET-58 SET-59 SET-90 SET-91 SET-92 SET-97 REC-151 a boot ignores what does not fit and uses the rest of the file", () => {
  const known = new Set(["asphodel", "cron", "notes"])
  expect(Settings.lenient("{ nope", known)).toMatchObject({
    file: Settings.empty,
    ignored: [],
  })
  expect(Settings.lenient("{ nope", known).unparsable).toBeDefined()
  expect(
    Settings.lenient(
      JSON.stringify({
        model: "x",
        plugins: {
          asphodel: { settings: { url: "u" }, extra: 1 },
          cron: { enabled: "no", settings: { a: 1 } },
          notes: { enabled: false, settings: "s" },
          gone: {},
        },
      }),
      known,
    ),
  ).toEqual({
    file: {
      plugins: {
        asphodel: { settings: { url: "u" } },
        notes: { enabled: false },
      },
    },
    unparsable: undefined,
    ignored: [
      "model",
      "plugins.asphodel.extra",
      "plugins.cron",
      "plugins.notes.settings",
      "plugins.gone",
    ],
  })
  expect(
    Settings.lenient(JSON.stringify({ plugins: 3, other: 1 }), known),
  ).toEqual({
    file: Settings.empty,
    unparsable: undefined,
    ignored: ["other", "plugins"],
  })
})

it("SET-65 SET-67 SET-68 SET-70 SET-71 SET-72 SET-93 SET-13 the provider records each key, where its value came from and when it was read, and never a value", async () => {
  const expanded = await Effect.runPromise(
    Settings.expand(
      {
        url: "http://${HOST}:${PORT:-7720}",
        token: "${TOKEN}",
        log: { verbose: true, unused: 1 },
        tags: ["a", "b"],
        tokn: "typo",
      },
      (name) =>
        Effect.succeed(
          name === "TOKEN"
            ? Option.some({ value: "s3cret-value", from: "store" as const })
            : name === "HOST"
              ? Option.some({ value: "asphodel", from: "env" as const })
              : Option.none(),
        ),
    ),
  )
  const recorder = Settings.recorder(expanded)
  const read = <A>(config: Config.Config<A>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* config
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, recorder.provider),
      ),
    )
  expect(await read(Config.String("url"))).toBe("http://asphodel:7720")
  expect(await read(Config.Redacted("token"))).toBeDefined()
  expect(await read(Config.Boolean("verbose").pipe(Config.nested("log")))).toBe(
    true,
  )
  expect(
    await read(Config.schema(Schema.Array(Schema.String), "tags")),
  ).toEqual(["a", "b"])
  expect(
    await read(Config.String("bank").pipe(Config.withDefault("chad"))),
  ).toBe("chad")
  recorder.loaded()
  expect(await read(Config.String("tokn"))).toBe("typo")
  // There is no fallback to process env (SET-12).
  process.env["CHAD_SETTINGS_PROBE"] = "from-env"
  expect(
    await read(Config.option(Config.String("CHAD_SETTINGS_PROBE"))),
  ).toEqual(Option.none())
  delete process.env["CHAD_SETTINGS_PROBE"]
  expect(recorder.items()).toEqual([
    {
      key: "url",
      sources: [
        { from: "file" },
        { from: "env", name: "HOST" },
        { from: "inline", name: "PORT" },
      ],
      at: "load",
    },
    { key: "token", sources: [{ from: "store", name: "TOKEN" }], at: "load" },
    { key: "log.verbose", sources: [{ from: "file" }], at: "load" },
    { key: "tags", sources: [{ from: "file" }], at: "load" },
    { key: "bank", sources: [{ from: "default" }], at: "load" },
    { key: "tokn", sources: [{ from: "file" }], at: "call" },
    { key: "CHAD_SETTINGS_PROBE", sources: [{ from: "default" }], at: "call" },
  ])
  expect(recorder.unread()).toEqual(["log.unused", "tokn"])
  const printed = [
    ...Messages.settingsListing("probe", recorder.items(), recorder.unread()),
    Messages.settingsStatus(recorder.items()),
  ].join("\n")
  expect(printed).not.toContain("s3cret-value")
  expect(printed).not.toContain("asphodel")
  expect(printed).not.toContain("7720")
})

it("CRED-109 CRED-23 CRED-31 the lines chad secret prints are templates of the Messages module, in the spec's wording", () => {
  expect([
    Messages.secretSaved("NAME", false, []),
    Messages.secretSaved("NAME", true, []),
    Messages.secretMissing("run", "NAME"),
  ]).toEqual([
    "Saved NAME",
    "Replaced NAME",
    "chad secret run: no secret named NAME",
  ])
})
