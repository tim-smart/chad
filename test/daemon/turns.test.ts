import { expect, test } from "vitest"
import { scenario, type Scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { found, posted, says } from "../support/owner.ts"

/** Waits until a statement gives a row, and gives the first. */
const row = async (running: Scenario, sql: string) => {
  const [first] = await found(running, sql)
  return first!
}

test("a turn's usage is the total of its model calls, a sub-agent's included, the output tokens include the reasoning tokens, and a script that fails goes back to the model as its output and does not fail the turn", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    {
      ...runs(
        'await subagent({ description: "a sub-agent", prompt: "Fail." })',
      ),
      usage: { input: 100, output: 20, cached: 40, reasoning: 5 },
    },
    // The sub-agent's two calls: a script that throws, and its end.
    {
      ...runs('throw new Error("the script failed")'),
      usage: { input: 1000, output: 200, cached: 400, reasoning: 50 },
    },
    {
      ...runs('await taskComplete("it failed")'),
      usage: { input: 2000, output: 300, cached: 1000 },
    },
    {
      text: "done",
      usage: { input: 150, output: 30, cached: 100, reasoning: 10 },
    },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)

  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(4)
  expect(String(results(calls[2])[0])).toContain("the script failed")
  expect(await posted(running, thread)).toEqual(["done"])
  const turn = await row(
    running,
    "SELECT * FROM turns WHERE outcome IS NOT NULL",
  )
  expect(turn).toMatchObject({
    outcome: "answered",
    failure: null,
    input_tokens: 3250,
    output_tokens: 550,
    cache_read_tokens: 1540,
    cache_write_tokens: 0,
    // What the turn's own last call read, and not a sum.
    context_tokens: 150,
  })
  const line = await running.logged("turn.ended")
  expect(line.annotations).toMatchObject({
    input_tokens: 3250,
    output_tokens: 550,
  })
})
