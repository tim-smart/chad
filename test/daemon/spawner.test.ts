import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatThread } from "effect/chat"
import { expect, onTestFinished, test } from "vitest"
import { owner, type Scenario, scenario } from "../support/driver.ts"
import { printed, runs } from "../support/model.ts"

/** An owner's message, delivered to the daemon. */
const ask = async (
  { fakes }: Scenario,
  thread: ChatThread.ChatThread,
  text: string,
) => {
  const event = await fakes.chat.userPosts(thread, { text, authorId: owner })
  expect(await fakes.chat.deliver(event)).toBe(true)
}

/** Sets a variable of this process, which is the daemon's, until the test is over. */
const set = (name: string, value: string) => {
  const before = process.env[name]
  process.env[name] = value
  onTestFinished(() => {
    if (before === undefined) delete process.env[name]
    else process.env[name] = before
  })
}

/**
 * Puts an `rg` and a `gh` that print their own name and the marker first on the daemon's path. The real ones print
 * nothing of their environment.
 */
const commands = (directory: string) => {
  const bin = join(directory, "bin")
  mkdirSync(bin, { recursive: true })
  for (const name of ["rg", "gh"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $CHAD_SESSION"\n`)
    chmodSync(join(bin, name), 0o755)
  }
  set("PATH", `${bin}:${process.env["PATH"]}`)
}

/** A script that prints the marker a child process sees. */
const marker = 'console.log(await run("printenv CHAD_SESSION"))'

/** The script of a turn that prints what a child process sees, once for each way clanka starts one. */
const every = `
await subagent({ prompt: "Print the marker." })
const agent = await subagent({ prompt: "Print the marker.", background: true })
const job = await bash({ command: "printenv CHAD_SESSION", background: true })
await waitTasks({ ids: [agent.id, job.id] })
console.log(JSON.stringify({
  run: await run("printenv CHAD_SESSION"),
  bash: (await bash({ command: "printenv CHAD_SESSION" })).output,
  background: (await taskOutput(job.id)).output,
  rg: await rg({ pattern: "marker" }),
  gh: await gh(["marker"]),
  kept: await run("printenv CHAD_KEPT"),
}))
`

test("every process a session starts carries CHAD_SESSION with the session's id and keeps the rest of its environment: bash, background bash, run, rg, gh, a sub-agent's command and a background sub-agent's, and a second session's processes carry its own id", async () => {
  const running = await scenario()
  const { fakes } = running
  commands(running.directory)
  set("CHAD_KEPT", "kept")
  await fakes.model.script([
    runs(every),
    // Each sub-agent makes two calls: it runs a command, and then it is done.
    runs(marker),
    runs('await taskComplete("printed")'),
    runs(marker),
    runs('await taskComplete("printed")'),
    { text: "done" },
    // The second session's turn.
    runs(marker),
    { text: "done" },
  ])
  const first = await fakes.chat.makeThread("direct")
  await ask(running, first, "hello")
  await fakes.chat.answers(first, 1)
  const second = await fakes.chat.makeThread("direct")
  await ask(running, second, "hello")
  await fakes.chat.answers(second, 1)

  const sessions = await running.chad([
    "db",
    "query",
    "--json",
    "SELECT id FROM sessions ORDER BY created_at, rowid",
  ])
  const ids: ReadonlyArray<string> = JSON.parse(sessions.stdout).map(
    (row: { id: string }) => row.id,
  )
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])

  // What a child printed is what the model's next call carries as the result of the tool it called.
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(8)
  const [, , agent, , background, parent, , other] = calls.map(printed)
  expect(agent).toEqual([`${ids[0]}\n\n`])
  expect(background).toEqual([`${ids[0]}\n\n`])
  expect(JSON.parse(String(parent?.[0]))).toEqual({
    run: `${ids[0]}\n`,
    bash: `${ids[0]}\n`,
    background: `${ids[0]}\n`,
    rg: `rg ${ids[0]}`,
    gh: `gh ${ids[0]}\n`,
    kept: "kept\n",
  })
  expect(other).toEqual([`${ids[1]}\n\n`])
})
