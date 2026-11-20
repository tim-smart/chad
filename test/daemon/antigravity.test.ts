import { statSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Cli from "../support/cli.ts"
import { scenario } from "../support/driver.ts"
import { antigravityCode, antigravityModel } from "../support/model.ts"
import { says } from "../support/owner.ts"

const spec = `antigravity/${antigravityModel}`
const next = `${spec}/low`

/** The file of the Antigravity sign-in's token on a scenario's volume, under clanka's key. */
const tokenFile = (data: string) =>
  join(data, "secrets", "auth", encodeURIComponent("antigravity.auth/token"))

test("with no sign-in a turn on an Antigravity model fails at once and chad model refuses it; chad login antigravity signs in through the daemon with the code Google showed and lists the account's models, after which chad model accepts the model and the next turn runs on Cloud Code", async () => {
  const running = await scenario({ env: { CHAD_MODEL: spec } })
  const { fakes, model, data } = running

  // No sign-in: the check at start skipped it, a turn fails at once without starting a sign-in, and chad model refuses.
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  const [failed] = await fakes.chat.answers(thread, 1)
  expect(failed?.text).toBe(Messages.antigravitySignInNeeded)
  expect(model.calls()).toEqual([])
  expect(model.checks()).toEqual([])
  expect((await running.chad(["status"])).stdout).toContain(
    `model: ${spec} (not logged in)`,
  )

  const refused = await running.chad(["model", next])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(Messages.antigravityNotSignedIn)
  expect(model.checks()).toEqual([])

  // A wrong code fails the sign-in and stores nothing; no argument defaults to the model in force.
  const wrong = await running.chad(["login"], {}, "not-it\n")
  expect(wrong.code).toBe(1)
  expect(wrong.stdout).toContain("https://accounts.google.com/o/oauth2/auth?")
  expect(() => statSync(tokenFile(data))).toThrow()

  // A newer chad login replaces one that waits for its code. The older code is refused before it reaches the newer
  // sign-in, which still takes its own.
  const link = "https://accounts.google.com/o/oauth2/auth?"
  const older = Cli.start(["login", "antigravity"], { CHAD_DATA: data }, false)
  await older.printed(link)
  const newer = Cli.start(["login", "antigravity"], { CHAD_DATA: data }, false)
  await newer.printed(link)
  older.child.stdin!.end(`${antigravityCode}\n`)
  const replaced = await older.done
  expect(replaced.code).toBe(1)
  expect(replaced.stderr).toContain(Messages.antigravityLoginReplaced)

  // The valid code signs in through the daemon, keeps the token private and never echoes the code.
  newer.child.stdin!.end(`${antigravityCode}\n`)
  const login = await newer.done
  expect(login.code).toBe(0)
  expect(login.stdout).toContain(
    Messages.antigravitySignedIn([antigravityModel]),
  )
  expect(statSync(tokenFile(data)).mode & 0o777).toBe(0o600)
  expect(login.stdout + login.stderr).not.toContain(antigravityCode)

  const changed = await running.chad(["model", next])
  expect(changed.code).toBe(0)
  expect(changed.stderr).toBe("")
  expect(changed.stdout).toContain(Messages.modelNow(next))
  expect(model.checks().map((call) => call.path)).toEqual([
    expect.stringMatching(/^\/cloudcode\//),
  ])
  expect((await running.chad(["status"])).stdout).toContain(
    `model: ${next} (logged in)`,
  )

  model.script([{ text: "answered on Cloud Code" }])
  await says(running, thread, "hello again")
  const [, answer] = await fakes.chat.answers(thread, 2)
  expect(answer?.text).toBe("answered on Cloud Code")
  expect(model.calls().map((call) => call.path)).toEqual([
    expect.stringMatching(/^\/cloudcode\//),
  ])
})
