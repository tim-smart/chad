// The Agent rebuild by generation: a model change rebuilds each session's Agent at its next turn's start.
import { expect, test } from "vitest"
import { scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { eventually, prompted, says, sessions } from "../support/owner.ts"

test("a model change rebuilds the Agent at the next turn, which keeps the history, lists the task the old Agent started and is told that it ended", async () => {
  const running = await scenario()
  const { fakes, model } = running
  await fakes.model.script([
    runs(
      `const job = await bash({ command: "sleep 0.2; echo out", background: true }); console.log(job.id)`,
    ),
    { text: "started" },
    runs(
      `console.log(JSON.stringify((await listTasks()).map((task) => task.id)))`,
    ),
    { text: "listed" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "start a job")
  await fakes.chat.answers(thread, 1)
  const job = results((await fakes.model.calls())[1]).join("")
  expect(job).toContain("bash_")
  const id = /bash_\d+/.exec(job)![0]

  expect((await running.chad(["model", "openai-compat/next"])).code).toBe(0)
  // The job ends while the session is idle, after the change and before the next turn.
  await eventually(
    () => sessions(running)[0]?.["tasks"],
    (tasks) => tasks === "[]",
  )
  await says(running, thread, "list them")
  await fakes.chat.answers(thread, 2)

  const calls = model.calls()
  expect(calls[2]?.body).toMatchObject({ model: "next" })
  // The notice is chad's, in its update message: the old Agent, which would have told it, is gone.
  const sent = JSON.stringify(calls[2]?.body)
  expect(sent).toContain("start a job")
  expect(sent).toContain("started")
  expect(sent).toContain(
    `<environment-update>\\n<task id=\\"${id}\\" kind=\\"bash\\" status=\\"completed\\" exitCode=\\"0\\">`,
  )
  expect(prompted(calls[2])).toContain("list them")
  expect(results(calls[3]).join("")).toContain(id)
})
