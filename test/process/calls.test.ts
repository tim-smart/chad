// The CLI against a daemon that goes away in the middle of a call (docs/spec/10-cli.md, CLI-19).
import { expect, test } from "vitest"
import type { Connection } from "../../dist/daemon/Connection.js"
import * as Messages from "../../dist/Messages.js"
import * as Cli from "../support/cli.ts"
import { eventually } from "../support/owner.ts"
import { daemon, type Process } from "../support/process.ts"

const home: Connection = {
  name: "home",
  kind: "discord",
  token: "home-token",
  owners: ["700000000000000001"],
}

/** Starts `chad connection check`, and resolves once the daemon's own request to Discord for it is waiting. */
const checking = async (running: Process) => {
  const before = running.discord.rest.calls().length
  const release = running.discord.rest.hold("home-token")
  const check = Cli.start(["connection", "check", "home"], {
    CHAD_DATA: running.data,
  })
  await eventually(
    () => running.discord.rest.calls().length,
    (count) => count > before,
  )
  return { check, release }
}

test("CLI-19 a daemon stopped in the middle of a call ends the command with exit 4 and the message to run chad status and chad logs", async () => {
  const running = await daemon({ connections: [home] })
  const current = await running.start()
  const { check, release } = await checking(running)
  current.signal("SIGTERM")
  const ran = await check.done
  release()
  expect(ran.code).toBe(4)
  expect(ran.stderr).toContain(Messages.daemonGone("connection check"))
}, 20_000)

test("CLI-19 a daemon that stops answering in the middle of a call ends the command with exit 4 once the RPC ping of 5 seconds goes unanswered", async () => {
  const running = await daemon({ connections: [home] })
  const current = await running.start()
  const { check, release } = await checking(running)
  current.signal("SIGSTOP")
  const ran = await check.done
  release()
  expect(ran.code).toBe(4)
  expect(ran.stderr).toContain(Messages.daemonGone("connection check"))
}, 30_000)
