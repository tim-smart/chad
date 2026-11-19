// The secret store as the owner, the agent and a plugin reach it: `chad secret set`, `list`, `rm` and `run` with and
// without the daemon, the form an owner fills when the agent asks for a secret, the reload of the plugins whose settings
// name a secret, and the check that no command prints a stored value. And `requestOnce`, which asks the owner for a value
// that only the calling script gets.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { ChatThread } from "effect/chat"
import { Config, Duration, Effect, Layer, Redacted } from "effect"
import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Once from "../../dist/daemon/Once.js"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import requestSecret from "../../dist/plugins/request-secret/index.js"
import { applied } from "../support/applied.ts"
import * as Cli from "../support/cli.ts"
import { fresh, owner, scenario, type Scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import * as Skills from "../support/skills.ts"
import {
  eventually,
  posted,
  says,
  sessions,
  threadOf,
} from "../support/owner.ts"

/**
 * A plugin that reads `token` while it loads, as `Config.Redacted`, and cannot be built when the token is `refused`. `state`
 * holds what its last good build read and its count of builds.
 */
const keyed = (refused = "refused") => {
  const state = { builds: 0, token: undefined as string | undefined }
  const plugin = Plugin.make(
    Layer.effectDiscard(
      Effect.gen(function* () {
        state.builds++
        const token = Redacted.value(yield* Config.Redacted("token"))
        if (token === refused)
          return yield* Effect.die(new Error("the token was refused"))
        state.token = token
      }),
    ),
  )
  return { state, plugin }
}

const chadJson = (plugins: object) =>
  JSON.stringify({ plugins }, null, 2) + "\n"

const store = (data: string) =>
  JSON.parse(
    readFileSync(join(data, "secrets/secrets.json"), "utf8"),
  ) as Record<
    string,
    { readonly value: string; readonly note?: string; readonly date: string }
  >

/**
 * A volume with KEY saved by the CLI with no daemon, and an applied chad.json in which two plugins name it, and in which a
 * repo plugin whose module throws as it loads names OTHER.
 */
const volume = async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  expect(
    await Cli.chad(
      ["secret", "set", "KEY", "--note", "example.com tim"],
      { CHAD_DATA: data },
      "first-0c1e\n",
    ),
  ).toMatchObject({
    code: 0,
    stdout: Messages.secretSaved("KEY", false, []) + "\n",
  })
  applied(join(data, "repo"), {
    "chad.json": chadJson({
      keyed: { settings: { token: "${KEY}" } },
      plain: { settings: { token: "inline" } },
      quiet: { enabled: false, settings: { token: "${KEY}" } },
      flaky: { settings: { token: "${OTHER}" } },
    }),
    "persona.md": "",
    "plugins/flaky.ts": `import { Layer } from "effect"
import { Plugin } from "chad"

throw new Error("flaky cannot start")
export default Plugin.make(Layer.empty)
`,
  })
  return directory
}

const boot = (directory: string) => {
  const plugins = { keyed: keyed(), plain: keyed(), quiet: keyed() }
  return scenario({
    directory,
    plugins: Object.entries(plugins).map(([name, { plugin }]) => ({
      name,
      plugin,
    })),
  }).then((running) => ({ running, ...plugins }))
}

const set = (
  running: Scenario,
  name: string,
  value: string,
  env: Record<string, string> = {},
) => running.chad(["secret", "set", name], env, value + "\n")

test("a saved or removed secret reloads the plugins whose settings name it and no other; one that fails keeps its old version, exits 1 and is marked; rm from a session posts its line; the next boot skips it and the next save loads it; saves at once are all kept", async () => {
  const directory = await volume()
  const { running, keyed, plain, quiet } = await boot(directory)
  await eventually(
    () => keyed.state.token,
    (token) => token === "first-0c1e",
  )
  await eventually(
    () => plain.state.token,
    (token) => token === "inline",
  )
  expect(quiet.state.builds).toBe(0)

  // A new value reaches the plugin that names it, through its Config, and nothing else is built.
  expect(await set(running, "KEY", "second-5d2a")).toMatchObject({
    code: 0,
    stdout: Messages.secretSaved("KEY", true, ["keyed"]) + "\n",
  })
  expect(keyed.state).toEqual({ builds: 2, token: "second-5d2a" })
  expect([plain.state.builds, quiet.state.builds]).toEqual([1, 0])
  expect(store(running.data)["KEY"]).toMatchObject({
    value: "second-5d2a",
    note: "example.com tim",
  })
  expect(
    statSync(join(running.data, "secrets/secrets.json")).mode & 0o777,
  ).toBe(0o600)

  // Saves made at once each go through the queue, and none is lost.
  const names = ["A1", "A2", "A3", "A4", "A5"]
  const saved = await Promise.all(
    names.map((name) => set(running, name, name.toLowerCase())),
  )
  expect(saved.map(({ code }) => code)).toEqual([0, 0, 0, 0, 0])
  const listed = JSON.parse(
    (await running.chad(["secret", "list", "--json"])).stdout,
  )
  expect(listed.map(({ name }: { name: string }) => name)).toEqual([
    ...names,
    "KEY",
  ])
  expect(listed.at(-1)).toEqual({
    name: "KEY",
    note: "example.com tim",
    date: store(running.data)["KEY"]?.date,
  })

  // A value the plugin cannot build with is stored, the plugin keeps its old version, and the command exits 1.
  const refused = await set(running, "KEY", "refused")
  expect(refused.code).toBe(1)
  expect(refused.stdout).toBe(Messages.secretSaved("KEY", true, []) + "\n")
  expect(refused.stderr).toContain("keyed: ")
  expect(refused.stderr).toContain("the token was refused")
  expect(store(running.data)["KEY"]?.value).toBe("refused")
  expect(keyed.state.token).toBe("second-5d2a")
  const mark = Messages.runningPrevious("secret", "").split(":")[0]
  expect((await running.chad(["status"])).stdout).toContain(
    `plugin: keyed, ${mark}: `,
  )

  // Removed from a session: the plugin cannot expand its settings and keeps its old version, and the line says so.
  const thread = await running.fakes.chat.makeThread("direct")
  await running.fakes.model.script([{ text: "ok" }])
  await says(running, thread, "hello")
  const session = String(
    (
      await eventually(
        () => sessions(running),
        (rows) => rows.length > 0,
      )
    )[0]?.["id"],
  )
  const removed = await running.chad(["secret", "rm", "KEY"], {
    CHAD_SESSION: session,
  })
  expect(removed.code).toBe(1)
  expect(removed.stdout).toBe(Messages.secretRemoved("KEY", []) + "\n")
  expect(removed.stderr).toContain("keyed: ")
  expect(Object.keys(store(running.data)).sort()).toEqual(names)
  await eventually(
    () => posted(running, threadOf(sessions(running)[0])),
    (lines) => lines.includes(`-# ${Messages.secretLine("KEY", ["keyed"])}`),
  )
  expect(await running.chad(["secret", "rm", "KEY"])).toMatchObject({
    code: 1,
    stderr: Messages.secretMissing("rm", "KEY") + "\n",
  })

  // Each save and removal left one line with the name and never the value.
  const ran = running
    .log()
    .filter(
      (line) =>
        line.annotations["event"] === "command.ran" &&
        String(line.annotations["command"]).startsWith("secret"),
    )
  expect(
    ran.map(({ annotations }) => [
      annotations["command"],
      annotations["caller"],
      annotations["outcome"],
    ]),
  ).toEqual([
    ["secret set", "owner", "changed"],
    ...names.map(() => ["secret set", "owner", "changed"]),
    ["secret set", "owner", "changed"],
    ["secret rm", session, "changed"],
    ["secret rm", "owner", "unchanged"],
  ])
  expect(
    ran.every(
      ({ annotations }) =>
        annotations["name"] === "KEY" ||
        names.includes(String(annotations["name"])),
    ),
  ).toBe(true)

  // The next boot builds with what is stored and skips the plugin, and the next save of the secret loads it.
  expect(await running.stop()).toBe(0)
  const again = await boot(directory)
  await eventually(
    async () => (await again.running.chad(["status"])).stdout,
    (text) => text.includes("plugin: keyed, skipped"),
  )
  expect(await set(again.running, "KEY", "third-9b4f")).toMatchObject({
    code: 0,
    stdout: Messages.secretSaved("KEY", false, ["keyed"]) + "\n",
  })
  expect(again.keyed.state.token).toBe("third-9b4f")
  expect(again.quiet.state.builds).toBe(0)

  // A repo plugin whose module cannot be loaded fails the save that retries it: the value is stored, it stays skipped, and
  // the command exits 1 with the load error.
  const other = await set(again.running, "OTHER", "fourth-2a7c")
  expect(other).toMatchObject({
    code: 1,
    stdout: Messages.secretSaved("OTHER", false, []) + "\n",
  })
  expect(other.stderr).toContain("flaky: ")
  expect(other.stderr).toContain("flaky cannot start")
  expect(store(again.running.data)["OTHER"]?.value).toBe("fourth-2a7c")
  expect((await again.running.chad(["status"])).stdout).toContain(
    "plugin: flaky, skipped",
  )
}, 60_000)

test("with no daemon the CLI keeps the store itself in a 0600 file, refuses a name it cannot hold, and secret run hands a value to its child by environment or stdin with the exit codes of a shell", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  const chad = (args: ReadonlyArray<string>, input?: string) =>
    Cli.chad(args, { CHAD_DATA: data }, input)

  const refused = await Promise.all([
    chad(["secret", "set", "lower"], "x"),
    chad(["secret", "set", "A".repeat(65)], "x"),
    chad(["secret", "set", "CHAD_DOLLAR"], "x"),
    chad(["secret", "set", "EMPTY"], "\n"),
  ])
  expect(refused.map(({ code, stderr }) => [code, stderr])).toEqual([
    [2, Messages.secretNameInvalid() + "\n"],
    [2, Messages.secretNameInvalid() + "\n"],
    [2, Messages.secretNameReserved() + "\n"],
    [2, Messages.secretNoValue() + "\n"],
  ])

  // A note stays across a save without one, and "" clears it.
  const value = 'it\'s a "value" $HOME'
  expect(
    (await chad(["secret", "set", "TOKEN", "--note", "site"], value + "\n"))
      .code,
  ).toBe(0)
  expect((await chad(["secret", "set", "TOKEN"], value)).stdout).toBe(
    Messages.secretSaved("TOKEN", true, []) + "\n",
  )
  expect(store(data)["TOKEN"]).toMatchObject({ value, note: "site" })
  expect(
    (await chad(["secret", "set", "TOKEN", "--note", ""], value)).code,
  ).toBe(0)
  expect(store(data)["TOKEN"]?.note).toBeUndefined()
  expect(statSync(join(data, "secrets")).mode & 0o777).toBe(0o700)
  expect(statSync(join(data, "secrets/secrets.json")).mode & 0o777).toBe(0o600)

  writeFileSync(join(directory, "plain.sh"), "#!/bin/sh\nexit 0\n", {
    mode: 0o644,
  })
  const started = join(directory, "started")
  const received = join(directory, "received")
  const run = (args: ReadonlyArray<string>) => chad(["secret", "run", ...args])
  const ran = await Promise.all([
    run([
      "--env",
      "T=TOKEN",
      "--",
      "sh",
      "-c",
      'test "$T" = "$1" && exit 7',
      "sh",
      value,
    ]),
    run(["--stdin", "TOKEN", "--", "sh", "-c", `cat > ${received}`]),
    run(["--env", "T=NOPE", "--", "touch", started]),
    run(["--env", "T", "--", "touch", started]),
    run(["--bogus", "--", "touch", started]),
    run(["--env", "T=TOKEN"]),
    run(["--", "no-such-command-3f1"]),
    run(["--", join(directory, "plain.sh")]),
    run(["--", "sh", "-c", "kill -TERM $$"]),
  ])
  expect(ran.map(({ code }) => code)).toEqual([
    7, 0, 125, 125, 125, 125, 127, 126, 143,
  ])
  expect(ran[2]?.stderr).toBe(Messages.secretMissing("run", "NOPE") + "\n")
  expect(ran[3]?.stderr).toBe(Messages.secretEnvPair("T") + "\n")
  expect(ran[6]?.stderr).toBe(
    Messages.secretNotFound("no-such-command-3f1") + "\n",
  )
  expect(readFileSync(received, "utf8")).toBe(value)
  expect(() => statSync(started)).toThrow()

  expect((await chad(["secret", "rm", "TOKEN"])).stdout).toBe(
    Messages.secretRemoved("TOKEN", []) + "\n",
  )
  expect((await chad(["secret", "list"])).stdout).toBe(
    Messages.secretsNone() + "\n",
  )
}, 30_000)

/**
 * Every command that exists, as the canary check runs it against a daemon. A new command belongs here too.
 * The ones that change something run in order after these.
 */
const everyCommand: ReadonlyArray<ReadonlyArray<string>> = [
  ["--help"],
  ["secret", "--help"],
  ["health"],
  ["status"],
  ["status", "--json"],
  ["connection", "list"],
  ["connection", "check"],
  ["model"],
  ["timezone"],
  ["safe"],
  ["log"],
  ["logs"],
  ["logs", "--json"],
  ["db", "check"],
  ["db", "query", "SELECT * FROM sessions"],
  ["check"],
  ["secret", "list"],
  ["secret", "list", "--json"],
  ["secret", "run", "--env", "X=CANARY", "--", "true"],
  ["secret", "run", "--stdin", "CANARY", "--", "sh", "-c", "cat > /dev/null"],
  ["setup", "--skip-login"],
]

/** The credentials skill's recipes, and the names of the secrets they read that no recipe of theirs saves. */
const credentials = Skills.recipes(
  Skills.files().find(({ name }) => name === "credentials/SKILL.md")!.text,
)
const recipeSecrets = [
  ...new Set(
    credentials.flatMap((recipe) =>
      [...recipe.matchAll(/--env [A-Z_]+=([A-Z_]+)|--stdin ([A-Z_]+)/g)].map(
        (match) => match[1] ?? match[2]!,
      ),
    ),
  ),
]

test("a stored canary is in no output of any command or of any credentials recipe, and nowhere in the log, a damaged store included", async () => {
  const canary = "canary-7e3b9d41c5"
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  for (const name of ["CANARY", ...recipeSecrets])
    expect(
      (await Cli.chad(["secret", "set", name], { CHAD_DATA: data }, canary))
        .code,
    ).toBe(0)
  applied(join(data, "repo"), {
    "chad.json": chadJson({ canary: { settings: { token: "${CANARY}" } } }),
    "persona.md": "",
  })
  const plugin = keyed()
  const running = await scenario({
    directory,
    plugins: [{ name: "canary", plugin: plugin.plugin }],
  })
  await eventually(
    () => plugin.state.token,
    (token) => token === canary,
  )
  // The daemon runs in this process, and the value its plugin read is not in its environment.
  expect(Object.values(process.env)).not.toContain(canary)

  const outputs: Array<Cli.Ran> = await Promise.all(
    everyCommand.map((args) => running.chad(args)),
  )
  expect(outputs[0]?.stdout).not.toContain(" get ")

  // Each recipe runs as the skill writes it, with `gh` and `curl` as commands that read what they are given and print
  // only that they ran. A recipe that saves a secret reads the canary on stdin.
  const bin = Skills.toolbox(join(directory, "bin"), ["gh", "curl"])
  const recipes = []
  for (const recipe of credentials)
    recipes.push(await Skills.shell(recipe, bin, { CHAD_DATA: data }, canary))
  expect(recipes.length).toBeGreaterThan(3)
  expect(
    recipes.filter(({ code, stderr }) => code !== 0 || stderr !== ""),
  ).toEqual([])
  outputs.push(...recipes)
  const changes: Array<Cli.Ran> = []
  const change = async (args: ReadonlyArray<string>, input?: string) => {
    changes.push(await running.chad(args, {}, input))
  }
  await change(["secret", "set", "CANARY"], canary)
  await change(["plugin", "reload", "canary"])
  await change(["plugin", "purge", "canary"])
  await change(["mcp", "restart"])
  await change(["plugin", "new", "canary-starter"])
  await change(["skill", "new", "canary-skill"])
  await change(["apply", "-m", "Nothing"])
  await change(["timezone", "Europe/Berlin"])
  await change(["owner", "add", "local", "someone"])
  await change(["owner", "remove", "local", "someone"])
  await change(["login"])
  await change(["logout"])
  await change(["safe", "on"])
  await change(["safe", "off"])
  await change(["secret", "rm", "CANARY"])
  expect(changes.map(({ code }) => code)).toContain(0)

  // A store that holds no store is refused by name, and what it holds is not quoted.
  writeFileSync(
    join(data, "secrets/secrets.json"),
    JSON.stringify({ CANARY: { value: canary, date: 5 } }),
  )
  for (const args of [
    ["secret", "list"],
    ["secret", "run", "--env", "X=CANARY", "--", "true"],
    ["status"],
    ["check"],
  ])
    changes.push(await running.chad(args))
  changes.push(await running.chad(["secret", "set", "OTHER"], {}, "x"))
  writeFileSync(join(data, "secrets/secrets.json"), `{"CANARY": "${canary}`)
  changes.push(await running.chad(["secret", "list"]))
  expect(changes.at(-1)?.stderr).toBe(
    Messages.secretStoreBroken(
      "list",
      "secrets/secrets.json is not a secret store",
    ) + "\n",
  )

  for (const { stdout, stderr } of [...outputs, ...changes]) {
    expect(stdout + stderr).not.toContain(canary)
  }
  expect(readFileSync(join(data, "logs/chad.log"), "utf8")).not.toContain(
    canary,
  )
  expect(
    running
      .log()
      .some(
        (line) =>
          line.annotations["event"] === "command.ran" &&
          line.annotations["name"] === "CANARY",
      ),
  ).toBe(true)
}, 60_000)

test("saves with no daemon, run at once and some killed partway, leave a store that reads, holds every save that exited 0, and no file another user can read", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  expect(
    (await Cli.chad(["secret", "set", "FIRST"], { CHAD_DATA: data }, "one"))
      .code,
  ).toBe(0)
  for (let round = 0; round < 3; round++) {
    const started = Array.from({ length: 8 }, (_, index) => {
      const name = `R${round}_${index}`
      return {
        name,
        running: Cli.start(
          ["secret", "set", name],
          { CHAD_DATA: data },
          "v".repeat(4096),
        ),
      }
    })
    // Every other one is killed when the one before it ends, which is while the others are reading or writing.
    started.forEach(({ running }, index) => {
      if (index % 2 === 1)
        void started[index - 1]!.running.done.then(() =>
          running.child.kill("SIGKILL"),
        )
    })
    const ended = await Promise.all(started.map(({ running }) => running.done))
    const held = store(data)
    expect(held["FIRST"]?.value).toBe("one")
    ended.forEach(({ code, stderr }, index) => {
      if (code === 0)
        expect(held[started[index]!.name]?.value).toHaveLength(4096)
      // One that found the lock taken by another is refused, with exit 1 or the 4 of a daemon that does not answer, as
      // every write with no daemon is, and loses nothing.
      else if (code !== null)
        expect([[1, 4].includes(code), stderr]).toEqual([
          true,
          expect.stringMatching(/^chad secret set: /),
        ])
    })
  }
  for (const file of readdirSync(join(data, "secrets")))
    expect(statSync(join(data, "secrets", file)).mode & 0o077).toBe(0)
  expect(statSync(join(data, "secrets")).mode & 0o777).toBe(0o700)
}, 60_000)

/** Every file under a directory, by its path relative to it. A link is not followed. */
const files = (root: string, under = ""): ReadonlyArray<string> =>
  readdirSync(join(root, under), { withFileTypes: true }).flatMap((entry) => {
    const path = join(under, entry.name)
    if (entry.isDirectory()) return files(root, path)
    return entry.isFile() ? [path] : []
  })

test("a canary quoted in a plugin build error stays in the secret store at start, on CLI and form saves, and on apply", async () => {
  const canary = "canary-87c35ef9b102"
  const envCanary = "env-canary-79c10a42c6"
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  const saved = await Cli.chad(
    ["secret", "set", "KEY"],
    { CHAD_DATA: data },
    canary,
  )
  expect(saved.code).toBe(0)
  const settings = (reason: string) =>
    chadJson({
      keyed: { settings: { token: "${KEY}", site: "${TEST_SITE}", reason } },
    })
  applied(join(data, "repo"), {
    "chad.json": settings("refused"),
    "persona.md": "",
    "plugins/keyed.ts": `import { Config, Effect, Layer, Redacted } from "effect"
import { Plugin } from "chad"

export default Plugin.make(Layer.effectDiscard(Effect.gen(function* () {
  const token = Redacted.value(yield* Config.Redacted("token"))
  const site = Redacted.value(yield* Config.Redacted("site"))
  const reason = yield* Config.String("reason")
  return yield* Effect.die(new Error(reason + " token " + token + " for " + site))
})))
`,
  })
  const running = await scenario({
    directory,
    env: { TEST_SITE: envCanary },
    plugins: [{ name: "request-secret", plugin: requestSecret }],
  })
  await running.logged("boot.ready")
  const status = await running.chad(["status"])
  const reloaded = await set(running, "KEY", canary)
  expect(reloaded.code).toBe(1)

  const { fakes } = running
  await fakes.model.script([
    runs(
      `console.log(await requestSecret({ name: "KEY", reason: "replace the test token" }))`,
    ),
    { text: "Enter the replacement." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "replace the token")
  await fakes.model.received(2)
  const request = (await fakes.chat.messages(thread)).find((message) =>
    message.text.includes("I need the secret `KEY`"),
  )!
  await Effect.runPromise(
    running.submit(
      request.id,
      "secret",
      { clicker: owner, submitter: owner },
      { value: canary },
    ),
  )
  const form = await eventually(
    async () =>
      (await posted(running, thread)).find((text) =>
        text.includes(Messages.secretSaved("KEY", true, [])),
      ),
    (text) => text !== undefined,
  )

  writeFileSync(join(data, "repo/work/chad.json"), settings("rejected"))
  const applying = await running.chad([
    "apply",
    "-m",
    "Change rejection reason",
  ])
  expect(applying.code).toBe(1)
  await running.stop()
  const masked = `token ${Once.mask} for ${Once.mask}`
  const refused = `refused ${masked}`
  expect(status.stdout).toContain("plugin: keyed, skipped")
  expect(status.stdout).toContain(refused)
  expect(reloaded.stderr).toContain("keyed")
  expect(reloaded.stderr).toContain(refused)
  expect(form).toContain(refused)
  expect(applying.stderr).toContain("keyed")
  expect(applying.stderr).toContain(`rejected ${masked}`)
  const outputs = [saved, status, reloaded, applying].flatMap(
    ({ stdout, stderr }) => [stdout, stderr],
  )
  outputs.push(
    JSON.stringify(await Effect.runPromise(running.chat.calls)),
    JSON.stringify(await fakes.model.calls()),
    JSON.stringify(running.log()),
  )
  for (const value of [canary, envCanary]) {
    for (const output of outputs) expect(output).not.toContain(value)
    expect(
      files(data).filter((path) =>
        readFileSync(join(data, path)).includes(value),
      ),
    ).toEqual(value === canary ? ["secrets/secrets.json"] : [])
  }
}, 60_000)

test("the agent's requestSecret posts a button whose form saves the secret as chad secret set does, a stranger's click opens no form, and the value is in no file on the volume but the store", async () => {
  const value = "canary-5f1d2a9e7b"
  const running = await scenario({
    plugins: [{ name: "request-secret", plugin: requestSecret }],
  })
  const { fakes } = running
  await fakes.model.script([
    runs(
      `console.log(await requestSecret({ name: "WEATHER_TOKEN", reason: "the forecast API needs it." }))`,
    ),
    { text: "Click the button." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "get the forecast")
  await fakes.model.received(2)
  const request = (await fakes.chat.messages(thread)).find((message) =>
    message.text.includes("I need the secret `WEATHER_TOKEN`"),
  )
  expect(request?.text).toContain("WEATHER_TOKEN")
  expect(results((await fakes.model.calls())[1]).join("\n")).toContain(
    "Posted a button for WEATHER_TOKEN",
  )

  const stranger = await Effect.runPromise(
    running.submit(
      request!.id,
      "secret",
      { clicker: "mallory", submitter: "mallory" },
      { value: "mallory's" },
    ),
  )
  expect(stranger.clicked._tag).toBe("Ack")
  expect(stranger.submitted).toBeUndefined()

  const filled = await Effect.runPromise(
    running.submit(
      request!.id,
      "secret",
      { clicker: owner, submitter: owner },
      { value, note: "weather.example, owner" },
    ),
  )
  expect(filled.clicked._tag).toBe("OpenModal")
  expect(filled.submitted?._tag).toBe("Close")
  const saved = await eventually(
    () => fakes.chat.messages(thread),
    (messages) =>
      messages.find((message) => message.id === request!.id)?.text !==
      request!.text,
  )
  expect(saved.find((message) => message.id === request!.id)?.text).toBe(
    Format.local.subtext(Messages.secretSaved("WEATHER_TOKEN", false, [])),
  )
  expect(store(running.data)).toEqual({
    WEATHER_TOKEN: {
      value,
      note: "weather.example, owner",
      date: expect.any(String),
    },
  })

  const click = await Effect.runPromise(
    running.chat.click(request!.id, "secret").pipe(Effect.result),
  )
  expect(click).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "NoSuchElement" },
  })

  // The daemon's log, its database and the session's directory are on the volume, and the chat and the model are not.
  await running.stop()
  expect(
    files(running.data).filter((path) =>
      readFileSync(join(running.data, path), "utf8").includes(value),
    ),
  ).toEqual(["secrets/secrets.json"])
  const chat = await Effect.runPromise(running.chat.calls)
  expect(JSON.stringify(chat)).not.toContain(value)
  expect(JSON.stringify(await fakes.model.calls())).not.toContain(value)
})

const requestOnce = (name: string) =>
  runs(
    `console.log(await requestOnce({ name: "${name}", reason: "example.com sent a login code by SMS to your phone." }))`,
  )

/** The request of a one-off value that chad posted in a thread, once it is there. */
const onceRequest = async (running: Scenario, thread: ChatThread.ChatThread) =>
  (
    await eventually(
      () => running.fakes.chat.messages(thread),
      (messages) =>
        messages.some((message) => message.text.includes("one-off value")),
    )
  ).find((message) => message.text.includes("one-off value"))!

test("the agent's requestOnce waits in its turn for the owner's form, a stranger's click opens no form, and only the calling script gets the owner's value, an OAuth callback address of a few hundred characters: a traced command, a print, the address's code pulled out of it raw and decoded, a command's output saved to a temporary file and a thrown error carry a mask, a command that prints it or a signal ends after the turn has ended carries the mask still, a later turn reads no copy from the tasks, and neither the value nor its code is on the volume, in the chat or in what the model is sent", async () => {
  // The code as the address carries it, percent-encoded, and as a script decodes it. Its apostrophe is one a URL
  // parser re-encodes, and one a single-quoted command line spells another way.
  const raw = "4%2F0Ab'7c3e9a41d2once"
  const decoded = "4/0Ab'7c3e9a41d2once"
  const scopes = ["calendar.events", "calendar.readonly", "userinfo.email"]
    .map((scope) => `https://www.googleapis.com/auth/${scope}`)
    .join(" ")
  // A parameter with a malformed escape, which a URL parser decodes in part, and one in the fragment.
  const nonce = "n%ZZ-4c1a/9e7b"
  const fragment = "fr-8d1e5a2c7b904f36"
  const value = `http://localhost/oauth/callback?state=st-9f2b6d81c4a7e035&iss=https%3A%2F%2Faccounts.google.com&code=${raw}&scope=${encodeURIComponent(scopes)}&nonce=n%ZZ-4c1a%2F9e7b&authuser=0&prompt=consent#session_state=${fragment}`
  const shell = (text: string) => text.replaceAll("'", "'\\''")
  const secrets = [
    value,
    shell(value),
    raw,
    shell(raw),
    decoded,
    nonce,
    fragment,
  ]
  expect(value.length).toBeGreaterThan(250)
  const running = await scenario({
    plugins: [{ name: "request-secret", plugin: requestSecret }],
  })
  // The background command prints once this file exists, which the next turn makes, after the turn that asked ended.
  const go = JSON.stringify(join(running.data, "..", "go"))
  const { fakes } = running
  await fakes.model.script([
    runs(
      [
        `const code = await requestOnce({ name: "OAUTH_CALLBACK", reason: "the address your browser ended on after you approved the sign-in." })`,
        `console.log(await run("test -n " + JSON.stringify(code) + " && echo nonempty"))`,
        // An OAuth script's first step: the code out of the address, decoded and as written.
        `const param = code.split("code=")[1].split("&")[0]`,
        `console.log("param " + decodeURIComponent(param) + " raw " + param)`,
        // A helper that parses the address as a URL, which decodes as a form does.
        `console.log(await run("node -e 'const u = new URL(process.argv[1]); console.log(\\"parsed\\", u.searchParams.get(\\"code\\"), u.searchParams.get(\\"nonce\\"), new URLSearchParams(u.hash.slice(1)).get(\\"session_state\\"))' " + JSON.stringify(code)))`,
        // The value handed to a command in single quotes, as the credentials skill does.
        `const sh = (text) => "'" + text.replaceAll("'", "'\\\\''") + "'"`,
        `console.log(await run("test -n " + sh(code) + " && echo quoted"))`,
        `console.log(await run("test -n " + sh(param) + " && echo rawquoted"))`,
        // A command's output is kept with its task, which a later turn can read.
        `await run("printf 'code=%s' " + JSON.stringify(code))`,
        `await bash({ command: "while [ ! -e " + ${JSON.stringify(go)} + " ]; do sleep 0.05; done; printf 'late=%s' " + JSON.stringify(code), description: "a late print", background: true })`,
        // A command a signal ends fails with an error that names its command line, which clanka keeps with the task.
        `await bash({ command: "while [ ! -e " + ${JSON.stringify(go)} + " ]; do sleep 0.05; done; test -n " + JSON.stringify(code) + "; kill -TERM $$", description: "a signalled command", background: true })`,
        // Output past clanka's limit goes to a temporary file, and the script sees its path.
        `console.log(await run("printf %s " + JSON.stringify(code) + "; head -c 40000 /dev/zero | tr '\\\\0' x"))`,
        `console.log("got " + code)`,
        `throw new Error("the site refused " + code)`,
      ].join("\n"),
    ),
    { text: "Logged in." },
    // The next turn lets the background command print, waits for it, and reads back what the tasks kept, descriptions
    // and output, reversed, which the mask of the exact value would not catch.
    runs(
      [
        `await run("touch " + ${JSON.stringify(go)})`,
        `const running = (await listTasks()).filter((task) => task.status === "running")`,
        `await waitTasks({ ids: running.map((task) => task.id) })`,
        `console.log(JSON.stringify((await listTasks()).map((task) => [task.description, task.output])).split("").reverse().join(""))`,
      ].join("\n"),
    ),
    { text: "Read the tasks." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "log in to example.com")
  const request = await onceRequest(running, thread)
  expect(request.text).toContain("OAUTH_CALLBACK")
  expect(await fakes.model.calls()).toHaveLength(1)

  const stranger = await Effect.runPromise(
    running.submit(
      request.id,
      "once",
      { clicker: "mallory", submitter: "mallory" },
      { value: "mallory's" },
    ),
  )
  expect(stranger.clicked._tag).toBe("Ack")
  expect(stranger.submitted).toBeUndefined()

  const filled = await Effect.runPromise(
    running.submit(
      request.id,
      "once",
      { clicker: owner, submitter: owner },
      { value },
    ),
  )
  expect(filled.clicked._tag).toBe("OpenModal")
  expect(filled.submitted?._tag).toBe("Close")
  // The script got the value: the command saw it, and the print and the error say where it was. A call carries the
  // whole history, so the script's own output is its last result.
  const returned = await fakes.model.received(2)
  const output = results(returned[1]).at(-1) ?? ""
  expect(output).toContain("nonempty")
  expect(output).toContain(`got ${Once.mask}`)
  expect(output).toContain(`param ${Once.mask} raw ${Once.mask}`)
  expect(output).toContain(`parsed ${Once.mask} ${Once.mask} ${Once.mask}`)
  expect(output).toContain(`test -n '${Once.mask}' && echo quoted`)
  expect(output).toContain(`test -n '${Once.mask}' && echo rawquoted`)
  expect(output).toContain("\nquoted")
  expect(output).toContain(`the site refused ${Once.mask}`)
  // The temporary file holds the mask, and not the value.
  const spooled = /Saved to: (\S+)/.exec(output)?.[1]
  expect(spooled).toBeDefined()
  const saved = readFileSync(spooled!, "utf8")
  expect(saved.startsWith(Once.mask)).toBe(true)
  expect(saved).not.toContain(value)
  // The request loses its button, so it takes no second click.
  await eventually(
    () => fakes.chat.messages(thread),
    (messages) =>
      messages.find((message) => message.id === request.id)?.text !==
      request.text,
  )
  expect(
    await Effect.runPromise(
      running.chat.click(request.id, "once").pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "NoSuchElement" } })
  await eventually(
    () => posted(running, thread),
    (lines) => lines.includes("Logged in."),
  )
  await says(running, thread, "what did the commands print?")
  const later = await fakes.model.received(4)
  const reverse = (text: string) => [...text].reverse().join("")
  const read = results(later[3]).at(-1) ?? ""
  expect(read).toContain(reverse(`late=${Once.mask}`))
  expect(read).toContain(reverse("a late print"))
  expect(read).toContain(reverse("receipt of signal: 'SIGTERM'"))
  for (const secret of secrets) {
    expect(JSON.stringify(later[3])).not.toContain(reverse(secret))
  }
  // The traced command line was logged with the mask.
  expect(
    running
      .log()
      .some((line) => JSON.stringify(line).includes(`test -n \\"${Once.mask}`)),
  ).toBe(true)
  expect(
    running
      .log()
      .some((line) =>
        JSON.stringify(line).includes(`test -n '${Once.mask}' && echo quoted`),
      ),
  ).toBe(true)
  expect(
    running
      .log()
      .some((line) =>
        JSON.stringify(line).includes(
          `test -n '${Once.mask}' && echo rawquoted`,
        ),
      ),
  ).toBe(true)

  // The daemon's log, its database and the session's directory are on the volume, and the chat and the model are not.
  await running.stop()
  const chat = JSON.stringify(await Effect.runPromise(running.chat.calls))
  const model = JSON.stringify(await fakes.model.calls())
  for (const secret of secrets) {
    expect(
      files(running.data).filter((path) =>
        readFileSync(join(running.data, path), "utf8").includes(secret),
      ),
    ).toEqual([])
    expect(chat).not.toContain(secret)
    expect(model).not.toContain(secret)
  }
  // The executor took its temporary file with it when it closed.
  expect(existsSync(spooled!)).toBe(false)
  expect(await running.chad(["secret", "list"])).toMatchObject({
    stdout: Messages.secretsNone() + "\n",
  })
})

test("a requestOnce the owner does not answer in time fails with a line the model can act on, and its request loses its button", async () => {
  const running = await scenario({
    plugins: [{ name: "request-secret", plugin: requestSecret }],
    timings: { onceWait: Duration.millis(200) },
  })
  const { fakes } = running
  await fakes.model.script([requestOnce("SMS_CODE"), { text: "It expired." }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "log in to example.com")
  const request = await onceRequest(running, thread)
  const calls = await fakes.model.received(2)
  expect(results(calls[1]).join("\n")).toContain("so the request expired")
  const messages = await fakes.chat.messages(thread)
  expect(messages.find((message) => message.id === request.id)?.text).not.toBe(
    request.text,
  )
  expect(
    await Effect.runPromise(
      running.chat.click(request.id, "once").pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "NoSuchElement" } })
})

test("a Stop while requestOnce waits ends the wait, and the request says so and loses its button", async () => {
  const running = await scenario({
    plugins: [{ name: "request-secret", plugin: requestSecret }],
  })
  const { fakes } = running
  await fakes.model.script([requestOnce("SMS_CODE")])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "log in to example.com")
  const request = await onceRequest(running, thread)
  const status = await eventually(
    () => fakes.chat.statuses(),
    (statuses) => statuses.length > 0,
  )
  expect(
    (await Effect.runPromise(running.click(status[0]!, "stop-turn", owner)))
      ._tag,
  ).toBe("Ack")
  await eventually(
    () => fakes.chat.messages(thread),
    (messages) =>
      messages.find((message) => message.id === request.id)?.text !==
      request.text,
  )
  expect(
    await Effect.runPromise(
      running.chat.click(request.id, "once").pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "NoSuchElement" } })
  expect(await fakes.model.calls()).toHaveLength(1)
})
