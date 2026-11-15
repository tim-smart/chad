// A defect that escapes a request's handler, in layer 4 (docs/spec/03-sessions-and-turns.md, SES-20). A regular file
// where the session's inbox goes makes the save of a steering message's attachment die, outside the turn.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { eventually, posted, rows, says } from "../support/owner.ts"
import { alive, daemon } from "../support/process.ts"

test("SES-20 a defect in the handler of a steering message fails that request alone: the activation and its background process stay, the next message is answered by it, and the request is not delivered again after a restart", async () => {
  const running = await daemon()
  const { fakes } = running
  const pidFile = join(running.directory, "background.pid")
  await fakes.model.script([
    {
      tool: {
        name: "execute",
        arguments: {
          script: `await bash({ command: "touch inbox" })
await bash({ command: "echo $$ > ${pidFile}; exec sleep 30", background: true })`,
        },
      },
    },
    { text: "first answer", hold: true },
    { text: "second answer" },
    { text: "third answer" },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "start a sleeper")
  await fakes.model.received(2)
  const pid = Number(readFileSync(pidFile, "utf8"))
  await says(running, thread, "see this file", {
    files: [
      {
        name: "notes.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("the notes"),
      },
    ],
  })
  // The steering message's request is answered with the defect, and the turn it meant to steer runs on.
  const [reply] = await eventually(
    () => rows(running, "SELECT payload FROM cluster_replies"),
    (found) => found.length > 0,
  )
  expect(String(reply!["payload"])).toContain('"_tag":"Die"')
  fakes.model.release(1)
  await fakes.chat.answers(thread, 1)
  // The activation was not restarted, which would have closed the session's background process.
  expect(alive(pid)).toBe(true)
  await says(running, thread, "and now")
  await fakes.chat.answers(thread, 2)
  expect(alive(pid)).toBe(true)

  await first.stop()
  await running.start()
  await says(running, thread, "after the restart")
  await fakes.chat.answers(thread, 3)
  expect(await posted(running, thread)).toEqual([
    "first answer",
    "second answer",
    "third answer",
  ])
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(4)
  expect(JSON.stringify(calls.map((call) => call.body))).not.toContain(
    "see this file",
  )
  expect(rows(running, "SELECT outcome FROM turns")).toEqual([
    { outcome: "answered" },
    { outcome: "answered" },
    { outcome: "answered" },
  ])
}, 20_000)
