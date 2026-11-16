// The end of a process scenario: a process that a session started in the background leaves its daemon's process group,
// so a kill of the daemon does not end it, and it may drop the mark every start's environment carries. The driver finds
// it by the process tree and the groups it recorded (`test/support/reap.ts`).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { eventually, says } from "../support/owner.ts"
import { alive, daemon } from "../support/process.ts"
import { table } from "../support/reap.ts"

test("a background process of a session outlives a kill of its daemon, whatever its environment holds, and the end of the scenario ends it", async () => {
  const running = await daemon()
  const { fakes } = running
  const pidFile = join(running.directory, "background.pid")
  const bareFile = join(running.directory, "bare.pid")
  await fakes.model.script([
    {
      tool: {
        name: "execute",
        arguments: {
          script: `const one = await bash({ command: "echo $$ > ${pidFile}; exec env -u CHAD_TEST_SCENARIO sleep 30", background: true })
const two = await bash({ command: 'env -i "$(command -v sleep)" 30 & echo $! > ${bareFile}; wait', background: true })
console.log(one.id, two.id)`,
        },
      },
    },
    { text: "never sent", hold: true },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "start a sleeper")
  const pidOf = (file: string) =>
    eventually(
      () => {
        try {
          return Number(readFileSync(file, "utf8"))
        } catch {
          return 0
        }
      },
      (value) => value > 0 && alive(value),
    )
  // One drops the mark and is the daemon's child. The other has an empty environment and is a grandchild.
  const pids = [await pidOf(pidFile), await pidOf(bareFile)]
  await fakes.model.received(2)
  await first.kill()
  expect(pids.map(alive)).toEqual([true, true])
  await running.close()
  expect(pids.map(alive)).toEqual([false, false])
}, 15_000)

test("a process table that cannot be read does not keep a kill or the end of the scenario from signalling the daemon, and fails the end", async () => {
  let broken = false
  const running = await daemon({
    processTable: () => {
      if (broken) throw new Error("ps exited with 2")
      return table()
    },
  })
  const first = await running.start()
  broken = true
  expect(await first.kill()).toMatchObject({ signal: "SIGKILL" })
  const second = await running.start()
  await expect(running.close()).rejects.toThrow("ps exited with 2")
  expect([first.pid, second.pid].map(alive)).toEqual([false, false])
  broken = false
}, 20_000)
