import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Duration } from "effect"
import { expect, test } from "vitest"
import * as Lock from "../../dist/Lock.js"
import * as Messages from "../../dist/Messages.js"
import * as Cli from "../support/cli.ts"
import { type Options, scenario } from "../support/driver.ts"
import { tokenFileName } from "../support/model.ts"
import {
  eventually,
  lines,
  posted,
  rows,
  says,
  statusMessages,
} from "../support/owner.ts"

/** A daemon on the Codex login with no token stored. */
const codex = {
  env: {
    CHAD_MODEL: "openai/gpt-6-astra/medium",
    CHAD_OPENAI_API_KEY: undefined,
  },
} satisfies Options

/** The prompt of the fake's nth device code. clanka names the issuer's page, whatever host a test sends it to. */
const prompt = (n: number) =>
  Messages.loginPrompt("https://auth.openai.com/codex/device", `FAKE-${n}`)

/** The notice a thread whose turn waits on another thread's login gets, in subtext. */
const waitingIn = (thread: { readonly id: string }) =>
  `-# ${Messages.loginWaitingIn(`<#${thread.id}>`)}`

/** What chad has posted in a thread, once it holds a text. */
const postedWith = (
  running: Parameters<typeof posted>[0],
  thread: Parameters<typeof posted>[1],
  text: string,
) =>
  eventually(
    () => posted(running, thread),
    (texts) => texts.includes(text),
  )

/** The token file on a scenario's volume. */
const tokenFile = (data: string) => join(data, "secrets", "auth", tokenFileName)

test("MOD-33 MOD-35 MOD-38 MOD-39 MOD-41 MOD-42 MOD-43 MOD-56 MOD-59 MOD-100 MOD-101 MOD-107 MOD-112 DIS-70 DIS-72 CLI-110 CLI-159 FAIL-251 FAIL-259 a turn with no login posts one code in its own thread, another thread's turn and chad login join that login, a killed chad login leaves it running, and every waiter runs once it completes, with no code or token in the log", async () => {
  const running = await scenario(codex)
  const { fakes, model, data } = running
  model.holdPolls()
  await fakes.model.script([{ text: "answered" }, { text: "answered" }])
  const first = await fakes.chat.makeThread("direct")
  const second = await fakes.chat.makeThread("direct")

  await says(running, first, "hello")
  await postedWith(running, first, prompt(1))
  await eventually(
    () => statusMessages(running, first),
    ([status]) => status?.includes(Messages.statusLoginWait) === true,
  )

  // The other thread's turn gets no code, only the notice that names the thread with the code.
  await says(running, second, "and here")
  await postedWith(running, second, waitingIn(first))

  // chad login joins the login and prints the same code. Killing it ends its own wait and nothing else.
  const killed = Cli.start(["login"], { CHAD_DATA: data })
  await killed.printed(prompt(1))
  killed.child.kill("SIGKILL")
  await killed.done
  const joined = Cli.start(["login"], { CHAD_DATA: data })
  await joined.printed(prompt(1))

  model.approve()
  expect(await postedWith(running, first, "answered")).toEqual([
    prompt(1),
    "answered",
  ])
  expect(await postedWith(running, second, "answered")).toEqual([
    waitingIn(first),
    "answered",
  ])
  const ended = await joined.done
  expect(ended.code).toBe(0)
  expect(ended.stdout).toBe(`${prompt(1)}\n${Messages.loggedIn}\n`)
  // One code for both turns and both CLIs, and no thread but the first saw it.
  expect(model.deviceCodes()).toBe(1)
  await lines(running, "model.logged-in", 1)
  expect(
    running
      .log()
      .filter((line) => line.annotations["event"] === "model.logged-in"),
  ).toHaveLength(1)
  await lines(running, "turn.login-wait", 2)

  const stored = JSON.parse(readFileSync(tokenFile(data), "utf8")) as {
    access: string
    refresh: string
  }
  expect(statSync(tokenFile(data)).mode & 0o777).toBe(0o600)
  await running.stop()
  const log = readFileSync(join(data, "logs", "chad.log"), "utf8")
  for (const secret of ["FAKE-1", stored.access, stored.refresh]) {
    expect(log).not.toContain(secret)
  }
})

test("MOD-44 MOD-45 MOD-74 MOD-75 DIS-71 TST-214 a login whose time runs out ends every waiting turn as LoginFailed with the reason TimedOut and the timeout message, and no waiter starts a second login", async () => {
  const running = await scenario({
    ...codex,
    timings: { modelLogin: Duration.seconds(3) },
  })
  const { fakes, model } = running
  await fakes.model.script([{ text: "never" }])
  const first = await fakes.chat.makeThread("direct")
  const second = await fakes.chat.makeThread("direct")
  await says(running, first, "hello")
  await postedWith(running, first, prompt(1))
  await says(running, second, "and here")
  await postedWith(running, second, waitingIn(first))

  expect(await postedWith(running, first, Messages.loginTimedOut)).toEqual([
    prompt(1),
    Messages.loginTimedOut,
  ])
  expect(await postedWith(running, second, Messages.loginTimedOut)).toEqual([
    waitingIn(first),
    Messages.loginTimedOut,
  ])
  const failed = await eventually(
    () => rows(running, "SELECT failure, failure_detail FROM turns"),
    (all) => all.length === 2 && all.every((row) => row["failure"] !== null),
  )
  for (const row of failed) {
    expect(row["failure"]).toBe("LoginFailed")
    expect(JSON.parse(String(row["failure_detail"]))).toEqual({
      _tag: "LoginFailed",
      reason: "TimedOut",
    })
  }
  expect(model.deviceCodes()).toBe(1)
  expect(await fakes.model.calls()).toEqual([])
})

test("MOD-47 MOD-48 MOD-60 MOD-61 CLI-111 a chad logout during a turn does not stop it, and a turn that then loses its login waits where it is with a code in its thread and carries on once the login completes", async () => {
  const running = await scenario({ ...codex, codex: "token" })
  const { fakes, model } = running
  model.holdPolls()
  // The first call is held while the owner logs out, then fails, so clanka opens a new socket, which needs a token.
  await fakes.model.script([
    { hold: true, status: 500 },
    { text: "carried on" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(1)

  const out = await running.chad(["logout"])
  expect(out).toEqual({
    code: 0,
    stdout: `${Messages.loggedOut}\n`,
    stderr: "",
  })
  await fakes.model.release(0)
  await postedWith(running, thread, prompt(1))
  await eventually(
    () => statusMessages(running, thread),
    ([status]) => status?.includes(Messages.statusLoginWait) === true,
  )
  model.approve()
  expect(await postedWith(running, thread, "carried on")).toEqual([
    prompt(1),
    "carried on",
  ])
  const [turn] = await eventually(
    () => rows(running, "SELECT outcome FROM turns"),
    (all) => all[0]?.["outcome"] === "answered",
  )
  expect(turn?.["outcome"]).toBe("answered")
  expect(model.deviceCodes()).toBe(1)
})

test("MOD-36 MOD-60 MOD-118 MOD-119 a chad login through the daemon with no turn waiting posts its code by the notice route as well as printing it, a turn then waits on it, and a second chad login with the token good says so", async () => {
  const running = await scenario({ ...codex, codex: "token" })
  const { fakes, model } = running
  model.holdPolls()
  await fakes.model.script([{ text: "first" }, { text: "second" }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await postedWith(running, thread, "first")

  expect(await running.chad(["logout"])).toMatchObject({ code: 0 })
  const login = Cli.start(["login"], { CHAD_DATA: running.data })
  await login.printed(prompt(1))
  // With no turn asking, the owner's most recent direct thread gets the code.
  await postedWith(running, thread, prompt(1))
  await says(running, thread, "again")
  await eventually(
    () => statusMessages(running, thread),
    ([status]) => status?.includes(Messages.statusLoginWait) === true,
  )
  model.approve()
  expect(await login.done).toMatchObject({
    code: 0,
    stdout: `${prompt(1)}\n${Messages.loggedIn}\n`,
  })
  expect(await postedWith(running, thread, "second")).toEqual([
    "first",
    prompt(1),
    "second",
  ])
  expect(await running.chad(["login"])).toEqual({
    code: 0,
    stdout: `${Messages.alreadyLoggedIn}\n`,
    stderr: "",
  })
  expect(model.deviceCodes()).toBe(1)
})

test("MOD-57 MOD-58 MOD-62 MOD-64 MOD-109 MOD-110 CLI-34 CLI-57c with no daemon chad login runs the device flow itself and stores a private token, fails when a daemon took the lock before it stored, logout clears the token, and both are refused to the agent", async () => {
  const running = await scenario(codex)
  const { model, data } = running
  model.holdPolls()
  await running.stop()

  for (const command of ["login", "logout"]) {
    const refused = await running.chad([command], { CHAD_SESSION: "s1" })
    expect(refused.code).toBe(3)
  }
  expect(model.deviceCodes()).toBe(0)

  const login = running.cli(["login"])
  await eventually(
    () => model.deviceCodes(),
    (count) => count === 1,
  )
  model.approve()
  expect(await login).toEqual({
    code: 0,
    stdout: `${prompt(1)}\n${Messages.loggedIn}\n`,
    stderr: "",
  })
  expect(statSync(tokenFile(data)).mode & 0o777).toBe(0o600)

  // A daemon that started while the owner logged in holds the lock when the token is to be stored.
  const logout = await running.chad(["logout"])
  expect(logout).toMatchObject({ code: 0 })
  expect(() => statSync(tokenFile(data))).toThrow()
  const raced = running.cli(["login"])
  await eventually(
    () => model.deviceCodes(),
    (count) => count === 2,
  )
  const release = Lock.take(join(data, "state", "daemon.lock"), Duration.zero)
  expect(release).toBeDefined()
  model.approve()
  expect(await raced).toEqual({
    code: 1,
    stdout: `${prompt(2)}\n`,
    stderr: `${Messages.loginRaced}\n`,
  })
  release?.()
  expect(() => statSync(tokenFile(data))).toThrow()

  // A provider that needs no login says so, and logout still clears a stored token.
  const compat = { CHAD_MODEL: "openai-compat/fake" }
  const none = await running.chad(["login"], compat)
  expect(none).toEqual({
    code: 0,
    stdout: `${Messages.loginNotNeeded("openai-compat/fake")}\n`,
    stderr: "",
  })
})

test("MOD-55 MOD-118 MOD-36 a chad login through the daemon prints its code and completes while the notice route's thread lookup does not answer", async () => {
  const first = await scenario()
  const direct = await first.fakes.chat.makeThread("direct")
  await says(first, direct, "/status")
  await first.fakes.chat.answers(direct, 1)
  expect(await first.stop()).toBe(0)

  // The notice route's destination is restored, and the lookup of its kind is held for the whole login.
  const running = await scenario({
    ...codex,
    directory: first.directory,
    timings: { modelLogin: Duration.seconds(10) },
  })
  expect(await running.fakes.chat.makeThread("direct")).toEqual(direct)
  const held = running.holdThreads()
  running.model.holdPolls()
  const login = Cli.start(["login"], { CHAD_DATA: running.data })
  await login.printed(prompt(1))
  running.model.approve()
  expect(await login.done).toMatchObject({
    code: 0,
    stdout: `${prompt(1)}\n${Messages.loggedIn}\n`,
  })
  expect(running.model.deviceCodes()).toBe(1)
  held.release()
  expect(await running.stop()).toBe(0)
})
