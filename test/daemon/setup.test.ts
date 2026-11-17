// `chad setup` as the owner runs it with no terminal: every answer as a flag on an empty volume, a run after the first
// that keeps what is stored, a new token that Discord refuses, and the same wizard with the daemon running.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { expect, onTestFinished, test } from "vitest"
import * as Discord from "../../dist/Discord.js"
import * as Messages from "../../dist/Messages.js"
import * as Rest from "../support/discord.ts"
import { fresh, httpClient, inProcess } from "../support/driver.ts"

const owner = "700000000000000001"

/** A file that holds a token. */
const tokenFile = (directory: string, token: string) => {
  const file = join(directory, `token-${token}`)
  writeFileSync(file, token + "\n", { mode: 0o600 })
  return file
}

const lines = (...printed: ReadonlyArray<string>) =>
  printed.map((line) => line + "\n").join("")

test("with no terminal and no daemon, setup names every missing flag and changes nothing, then takes every answer as a flag on an empty volume and turns the message content intent on; a run after the first keeps what is stored and exits 0, a refused token keeps the old one, and the token is never printed", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  const rest = await Rest.rest()
  onTestFinished(async () => {
    await rest.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const client = httpClient({ model: rest.url, discord: rest.url })
  const setup = (args: ReadonlyArray<string>, env = {}) =>
    inProcess(["setup", ...args], client, { CHAD_DATA: data, ...env })
  const connections = () =>
    JSON.parse(readFileSync(join(data, "secrets/connections.json"), "utf8"))
      .connections

  // Nothing is stored and nothing is given: each missing answer is named, and nothing is written.
  expect(await setup([])).toMatchObject({
    code: 2,
    stderr: lines(
      Messages.setupMissing([
        "--discord-token-file",
        "--owner",
        "--skip-login",
      ]),
    ),
  })
  expect(rest.calls()).toEqual([])

  // A blank owner is no owner: it is named as missing before the token is saved.
  expect(
    await setup([
      "--discord-token-file",
      tokenFile(directory, "first-token"),
      "--owner",
      "   ",
      "--skip-login",
    ]),
  ).toMatchObject({
    code: 2,
    stderr: lines(Messages.setupMissing(["--owner"])),
  })
  expect(rest.calls()).toEqual([])
  expect(existsSync(join(data, "secrets/connections.json"))).toBe(false)

  // Every answer as a flag.
  const first = await setup([
    "--discord-token-file",
    tokenFile(directory, "first-token"),
    "--owner",
    owner,
    "--timezone",
    "europe/berlin",
    "--skip-login",
  ])
  expect(first).toMatchObject({
    code: 0,
    stderr: "",
    stdout: lines(
      Messages.connectionAdded("discord", "discord"),
      Messages.connectionInvite(Discord.inviteUrl(Rest.application)),
      Messages.setupBot("chad"),
      Messages.setupIntent("on", Rest.application),
      Messages.ownerAdded(owner, "discord"),
      Messages.timezoneSet("Europe/Berlin"),
      Messages.setupLoginSkipped,
    ),
  })
  expect(connections()).toEqual([
    { name: "discord", kind: "discord", token: "first-token", owners: [owner] },
  ])
  expect(readFileSync(join(data, "state/timezone"), "utf8")).toBe(
    "Europe/Berlin\n",
  )
  const patched = rest
    .calls()
    .filter(
      (call) => call.method === "PATCH" && call.path === "/applications/@me",
    )
  expect(patched.map((call) => call.body)).toEqual([{ flags: 1 << 19 }])

  // A run after the first with no flags, or a blank owner, asks nothing, keeps every answer and names the bot, never the
  // token.
  const again = await setup(["--owner", " "], {
    CHAD_OPENAI_API_KEY: "sk-test",
  })
  expect(again).toMatchObject({
    code: 0,
    stderr: "",
    stdout: lines(
      Messages.setupTokenStored("discord", "chad"),
      Messages.setupOwnersKept([owner], "discord"),
      Messages.timezoneInForce("Europe/Berlin", "stored", undefined),
      Messages.loginNotNeeded("openai/gpt-6-astra/medium"),
    ),
  })

  // A new token that Discord refuses changes nothing; one it takes replaces the old, and an owner given again stays one.
  rest.refuse("refused-token")
  const refused = await setup([
    "--discord-token-file",
    tokenFile(directory, "refused-token"),
    "--skip-login",
  ])
  expect(refused.code).toBe(1)
  expect(connections()[0].token).toBe("first-token")
  const replaced = await setup([
    "--discord-token-file",
    tokenFile(directory, "second-token"),
    "--owner",
    owner,
    "--skip-login",
  ])
  expect(replaced.code).toBe(0)
  expect(replaced.stdout).toContain(Messages.connectionToken("discord"))
  expect(replaced.stdout).toContain(
    Messages.setupIntent("already", Rest.application),
  )
  expect(replaced.stdout).toContain(Messages.ownerListed(owner, "discord"))
  expect(connections()).toEqual([
    {
      name: "discord",
      kind: "discord",
      token: "second-token",
      owners: [owner],
    },
  ])
  for (const run of [first, again, refused, replaced]) {
    expect(run.stdout + run.stderr).not.toMatch(
      /first-token|refused-token|second-token/,
    )
  }
})
