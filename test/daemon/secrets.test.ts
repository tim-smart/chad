// The secret store as the owner, the agent and a plugin reach it: `chad secret set`, `list`, `rm` and `run` with and
// without the daemon, the reload of the plugins whose settings name a secret, and the check that no command prints a
// stored value.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { Config, Effect, Layer, Redacted } from "effect"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import { applied } from "../support/applied.ts"
import * as Cli from "../support/cli.ts"
import { fresh, scenario, type Scenario } from "../support/driver.ts"
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

/** A volume with KEY saved by the CLI with no daemon, and an applied chad.json in which two plugins name it. */
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
    }),
    "persona.md": "",
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

test("CRED-16 CRED-17 CRED-23 CRED-24 CRED-25 CRED-26 CRED-81 CRED-106 CRED-111 CRED-112 CRED-130 CLI-35b CLI-37 CLI-46d CLI-95 CLI-100 CLI-101 CLI-102 CLI-150 SET-26 SET-79 SET-80 SWAP-39 SWAP-94 SWAP-96 SWAP-97 SWAP-98 SWAP-121 SWAP-138 SWAP-139 SWAP-143 SWAP-148 REC-108 REC-124 LOAD-51 FAIL-238 FAIL-346 a saved or removed secret reloads the plugins whose settings name it and no other; one that fails keeps its old version, exits 1 and is marked; rm from a session posts its line; the next boot skips it and the next save loads it; saves at once are all kept", async () => {
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
}, 60_000)

test("CRED-18 CRED-19 CRED-22 CRED-24 CRED-28 CRED-29 CRED-30 CRED-31 CRED-32 CRED-113 CRED-114 CRED-115 CRED-137 CLI-31b CLI-49b CLI-51b CLI-95 CLI-98 CLI-99 CLI-103 SET-33 with no daemon the CLI keeps the store itself in a 0600 file, refuses a name it cannot hold, and secret run hands a value to its child by environment or stdin with the exit codes of a shell", async () => {
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
 * Every command that exists, as the canary check runs it against a daemon. A later slice adds its commands here
 * (TST-97). The ones that change something run in order after these.
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

test("TST-97 CLI-97 CRED-9 CRED-10 CRED-11 CRED-80 CRED-81 CRED-82 CRED-130 CRED-140 SET-21 a stored canary is in no output of any command and nowhere in the log, a damaged store included", async () => {
  const canary = "canary-7e3b9d41c5"
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  expect(
    (await Cli.chad(["secret", "set", "CANARY"], { CHAD_DATA: data }, canary))
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

  const outputs = await Promise.all(
    everyCommand.map((args) => running.chad(args)),
  )
  expect(outputs[0]?.stdout).not.toContain(" get ")
  const changes: Array<Cli.Ran> = []
  const change = async (args: ReadonlyArray<string>, input?: string) => {
    changes.push(await running.chad(args, {}, input))
  }
  await change(["secret", "set", "CANARY"], canary)
  await change(["plugin", "reload", "canary"])
  await change(["plugin", "purge", "canary"])
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

test("CRED-16 CLI-35 CLI-95 saves with no daemon, run at once and some killed partway, leave a store that reads, holds every save that exited 0, and no file another user can read", async () => {
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
