import { Config, ConfigProvider, Effect, Option, Schema } from "effect"
import { expect, it } from "vitest"
import * as Settings from "../../src/Settings.ts"
import * as Messages from "../../src/Messages.ts"

it("the provider records each key, where its value came from and when it was read, and never a value", async () => {
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
      config.pipe(
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
  // There is no fallback to process env.
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
