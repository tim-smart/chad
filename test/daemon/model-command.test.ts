import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Cli from "../support/cli.ts"
import { query } from "../support/database.ts"
import { owner, type Scenario, scenario } from "../support/driver.ts"
import { eventually } from "../support/owner.ts"

/** A message delivered to the daemon, from the owner unless another author is named. */
const says = async (
  { fakes }: Scenario,
  thread: ChatThread.ChatThread,
  text: string,
  authorId = owner,
) => {
  const event = await fakes.chat.userPosts(thread, { text, authorId })
  await fakes.chat.deliver(event)
}

const stateFile = (running: Scenario, name: string) =>
  join(running.data, "state", name)

/** A file of `state/`, or nothing when it is not there. */
const stored = (running: Scenario, name: string) => {
  const path = stateFile(running, name)
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

/** The environment of a `chad model` with no daemon, on the fake model's `openai-compat` endpoint. */
const alone = (running: Scenario) => ({
  CHAD_MODEL: "openai-compat/fake",
  CHAD_OPENAI_API_URL: running.model.url,
  CHAD_OPENAI_API_KEY: "fake-key",
})

const turnModels = (running: Scenario) =>
  query(running.data, "SELECT model FROM turns ORDER BY started_at").map(
    (row) => row["model"],
  )

// Each `chad` here is the real bin in its own process, which finds the daemon by its lock as an owner's shell does.

test("only an owner changes the model: a stranger's /model and an agent's chad model store nothing, and an owner's /model tries the model without a turn, posts where it was typed and is what the next session runs on, and /model --fast on sends the priority tier from a running session's next turn until it is turned off", async () => {
  const running = await scenario()
  const { fakes, model } = running
  const thread = await fakes.chat.makeThread("direct")

  await says(running, thread, "/model openai-compat/stranger", "stranger")
  for (const args of [["model", "openai-compat/agent"], ["model"]]) {
    const refused = await running.chad(args, { CHAD_SESSION: "s-agent" })
    expect(refused.code).toBe(3)
    expect(refused.stdout).toBe("")
  }
  expect(stored(running, "model")).toBeUndefined()

  await says(running, thread, "/model openai-compat/next")
  const [changed] = await fakes.chat.answers(thread, 1)
  expect(changed?.text).toBe(Messages.modelNow("openai-compat/next"))
  expect(stored(running, "model")).toBe("openai-compat/next\n")
  // The trial request went to the new model, and no turn ran.
  expect(model.checks().map((call) => call.body)).toContainEqual(
    expect.objectContaining({ model: "next" }),
  )
  expect(model.checks().map((call) => call.body)).not.toContainEqual(
    expect.objectContaining({ model: "stranger" }),
  )
  expect(model.calls()).toEqual([])
  expect(turnModels(running)).toEqual([])

  await says(running, thread, "/model")
  const [, shown] = await fakes.chat.answers(thread, 2)
  expect(shown?.text.split("\n")[0]).toBe(
    "model: openai-compat/next (needs no login)",
  )

  await fakes.model.script([{ text: "ok" }])
  const other = await fakes.chat.makeThread("direct")
  await says(running, other, "hello")
  await fakes.chat.answers(other, 1)
  expect(model.calls()[0]?.body).toMatchObject({ model: "next" })
  expect(turnModels(running)).toEqual(["openai-compat/next"])

  // Fast mode on the `openai` path: the trial asks for the tier, and so does the running session's next turn.
  await says(running, thread, "/model openai/quick --fast on")
  const [, , fast] = await fakes.chat.answers(thread, 3)
  expect(fast?.text).toBe(
    `${Messages.modelNow("openai/quick")}\n${Messages.modelFastNow(true, undefined)}`,
  )
  expect(model.checks().at(-1)?.body).toMatchObject({
    model: "quick",
    service_tier: "priority",
  })
  await fakes.model.script([{ text: "fast" }, { text: "plain" }])
  await says(running, other, "again")
  await fakes.chat.answers(other, 2)
  expect(model.calls()[0]?.body).toMatchObject({
    model: "quick",
    service_tier: "priority",
  })

  await says(running, thread, "/model --fast off")
  await fakes.chat.answers(thread, 4)
  await says(running, other, "and again")
  await fakes.chat.answers(other, 3)
  expect(model.calls()[1]?.body).toMatchObject({ model: "quick" })
  expect(model.calls()[1]?.body).not.toHaveProperty("service_tier")
})

test("with no daemon chad model tries the model itself, stores nothing when the trial fails, replaces state/model by rename so a write cut short leaves the old value, and a restart runs what it stored", async () => {
  const first = await scenario()
  await first.stop()
  const env = alone(first)

  first.model.failChecks(500)
  const failed = await first.chad(["model", "openai-compat/broken"], env)
  expect(failed.code).toBe(1)
  expect(stored(first, "model")).toBeUndefined()
  first.model.failChecks(undefined)

  const old = await first.chad(["model", "openai-compat/old"], env)
  expect(old.code).toBe(0)
  expect(old.stdout.trim()).toBe(Messages.modelNow("openai-compat/old"))
  const before = statSync(stateFile(first, "model")).ino
  const next = await first.chad(["model", "openai-compat/next"], env)
  expect(next.code).toBe(0)
  // A new file took the old one's name, so the old one was never written over in place.
  expect(statSync(stateFile(first, "model")).ino).not.toBe(before)
  expect(
    readdirSync(join(first.data, "state")).filter((name) =>
      name.endsWith(".tmp"),
    ),
  ).toEqual([])
  expect(first.model.checks().map((call) => call.body)).toContainEqual(
    expect.objectContaining({ model: "next" }),
  )

  const running = await scenario({ directory: first.directory })
  await running.fakes.model.script([{ text: "ok" }])
  const thread = await running.fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await running.fakes.chat.answers(thread, 1)
  expect(running.model.calls()[0]?.body).toMatchObject({ model: "next" })
  const shown = await running.chad(["model"])
  expect(shown.stdout.split("\n")[0]).toBe(
    "model: openai-compat/next (needs no login)",
  )
  await eventually(
    () => turnModels(running),
    (models) => models.length === 1,
  )
})

test("with no daemon, a chad model whose trial outlasts another change is planned again on what that change stored, so no override of another provider is stored", async () => {
  const first = await scenario()
  await first.stop()
  const env = { ...alone(first), CHAD_DATA: first.data }

  const held = first.model.holdChecks("small-held")
  const override = Cli.start(
    ["model", "--subagent", "openai-compat/small-held"],
    env,
  )
  await held.reached
  const moved = await first.chad(["model", "openai/new-main"], env)
  expect(moved).toMatchObject({
    code: 0,
    stdout: `${Messages.modelNow("openai/new-main")}\n`,
  })
  held.release()
  expect(await override.done).toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining(
      Messages.modelRefused(
        Messages.modelOverrideProvider("openai-compat/small-held", "openai"),
      ),
    ),
  })
  expect(stored(first, "model")?.trim()).toBe("openai/new-main")
  expect(stored(first, "subagent-model")).toBeUndefined()
  const shown = await first.chad(["model"], env)
  // What the next chad model shows is what was stored, with no override left out.
  expect(shown.stdout.split("\n")[0]).toMatch(/^model: openai\/new-main /)
  expect(shown.stdout.split("\n").slice(1)).toEqual([
    ...Messages.modelShown({
      main: "",
      subagent: undefined,
      summarizer: undefined,
      ignored: [],
      fast: Messages.modelFastShown(false, undefined),
    })
      .split("\n")
      .slice(1),
    "",
  ])
})
