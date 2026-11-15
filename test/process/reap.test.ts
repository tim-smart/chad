// The end of a process scenario (docs/spec/17-testing.md, TST-87): a process that a session started in the background
// leaves its own process group, so a kill of the daemon does not end it, and the driver finds it by the mark every
// start's environment carries.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { eventually, says } from "../support/owner.ts"
import { alive, daemon } from "../support/process.ts"

test("TST-87 a background process of a session outlives a kill of its daemon, and the end of the scenario ends it", async () => {
  const running = await daemon()
  const { fakes } = running
  const pidFile = join(running.directory, "background.pid")
  await fakes.model.script([
    {
      tool: {
        name: "execute",
        arguments: {
          script: `const job = await bash({ command: "echo $$ > ${pidFile}; exec sleep 30", background: true })
console.log(job.id)`,
        },
      },
    },
    { text: "never sent", hold: true },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "start a sleeper")
  const pid = await eventually(
    () => {
      try {
        return Number(readFileSync(pidFile, "utf8"))
      } catch {
        return 0
      }
    },
    (value) => value > 0 && alive(value),
  )
  await fakes.model.received(2)
  await first.kill()
  expect(alive(pid)).toBe(true)
  await running.close()
  expect(alive(pid)).toBe(false)
}, 15_000)
