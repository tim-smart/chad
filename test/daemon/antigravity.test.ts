import { statSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { scenario } from "../support/driver.ts"
import { antigravityCode, antigravityModel } from "../support/model.ts"
import { says } from "../support/owner.ts"

const spec = `antigravity/${antigravityModel}`

/** The file of the Antigravity sign-in's token on a scenario's volume, under clanka's key. */
const tokenFile = (data: string) =>
  join(data, "secrets", "auth", encodeURIComponent("antigravity.auth/token"))

test("chad login antigravity signs in through the daemon with the code Google showed and lists the account's models, after which chad model takes an Antigravity model it refused before and the next turn runs on Cloud Code", async () => {
  const running = await scenario()
  const { fakes, model, data } = running
  /** The trial requests that reached Cloud Code, past the check at start of the compat model. */
  const trials = () =>
    model.checks().filter((call) => call.path.startsWith("/cloudcode/"))

  // No sign-in: the change is refused before any request, and nothing signs in.
  const refused = await running.chad(["model", spec])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(Messages.antigravityNotSignedIn)
  expect(trials()).toEqual([])

  // A wrong code fails the sign-in and stores nothing.
  const wrong = await running.chad(["login", "antigravity"], {}, "not-it\n")
  expect(wrong.code).toBe(1)
  expect(wrong.stdout).toContain("https://accounts.google.com/o/oauth2/auth?")
  expect(() => statSync(tokenFile(data))).toThrow()

  const login = await running.chad(
    ["login", "antigravity"],
    {},
    `${antigravityCode}\n`,
  )
  expect(login.code).toBe(0)
  expect(login.stdout).toContain(
    Messages.antigravitySignedIn([antigravityModel]),
  )
  expect(model.signIns()).toBe(1)
  expect(statSync(tokenFile(data)).mode & 0o777).toBe(0o600)
  // The code goes from stdin to the daemon and is never printed.
  expect(login.stdout + login.stderr).not.toContain(antigravityCode)

  const changed = await running.chad(["model", spec])
  expect(changed.stderr).toBe("")
  expect(changed.stdout).toContain(Messages.modelNow(spec))
  expect(trials().map((call) => call.path)).toEqual([
    "/cloudcode/v1internal:streamGenerateContent?alt=sse",
  ])
  const status = await running.chad(["status"])
  expect(status.stdout).toContain(`model: ${spec} (logged in)`)

  model.script([{ text: "answered on Cloud Code" }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  const [answer] = await fakes.chat.answers(thread, 1)
  expect(answer?.text).toBe("answered on Cloud Code")
  expect(model.calls().map((call) => call.path)).toEqual([
    "/cloudcode/v1internal:streamGenerateContent?alt=sse",
  ])
})

test("a turn on an Antigravity model with no sign-in fails at once with the message that names chad login antigravity, and starts no sign-in", async () => {
  const running = await scenario({ env: { CHAD_MODEL: spec } })
  const { fakes, model } = running

  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  const [answer] = await fakes.chat.answers(thread, 1)
  expect(answer?.text).toBe(Messages.antigravitySignInNeeded)
  expect(model.calls()).toEqual([])
  expect(model.checks()).toEqual([])
  expect(model.signIns()).toBe(0)

  const status = await running.chad(["status"])
  expect(status.stdout).toContain(`model: ${spec} (not logged in)`)
})
