import { Duration } from "effect"
import { expect, test } from "vitest"
import { scenario } from "../support/driver.ts"
import { printed, runs } from "../support/model.ts"
import { lines, posted, rows, says, sessions } from "../support/owner.ts"

/** A turn that starts one background process which runs for a number of seconds, and prints the task's id. */
const background = (seconds: number) =>
  runs(
    `const job = await bash({ command: "sleep ${seconds}", background: true }); console.log(job.id)`,
  )

test(
  "when cluster takes the idle sessions out of memory it leaves a session whose background task still runs and one whose turn is in flight, the row lists a task while it runs, and a session whose task has ended goes",
  { timeout: 20_000 },
  async () => {
    const running = await scenario({
      timings: { sessionIdle: Duration.millis(300) },
    })
    const { fakes } = running
    await fakes.model.script([
      background(30),
      { text: "one" },
      background(0.3),
      { text: "two" },
      { text: "three", hold: true },
      { text: "four" },
    ])
    // One session has a task that outlives the scenario, one a task that ends at once, and one a turn that waits.
    const long = await fakes.chat.makeThread("direct")
    await says(running, long, "hello")
    await fakes.chat.answers(long, 1)
    const short = await fakes.chat.makeThread("direct")
    await says(running, short, "hello")
    await fakes.chat.answers(short, 1)
    const held = await fakes.chat.makeThread("direct")
    await says(running, held, "hello")
    const calls = await fakes.model.received(5)
    const [first, second, third] = sessions(running)

    // The turns of the first two have ended, and the first one's task is still in its row.
    await lines(running, "turn.ended", 2)
    expect(
      rows(running, "SELECT outcome FROM turns ORDER BY started_at"),
    ).toEqual([
      { outcome: "answered" },
      { outcome: "answered" },
      { outcome: null },
    ])
    expect(JSON.parse(String(first?.["tasks"]))).toEqual([
      { id: String(printed(calls[1])[0]).trim(), kind: "bash" },
    ])

    // Cluster looks for idle entities every five seconds at the least. Its first look takes the second session only.
    const passivated = await running.logged("session.passivated")
    expect(passivated.annotations["session"]).toBe(second?.["id"])
    expect(sessions(running)[1]?.["tasks"]).toBe("[]")

    // The first session is still in memory: its next message restores nothing, and its task is still in its row.
    await says(running, long, "again")
    await fakes.chat.answers(long, 2)
    await lines(running, "turn.ended", 3)
    expect(
      running
        .log()
        .filter((line) =>
          /^session\.(passivated|restored)$/.test(
            String(line.annotations["event"]),
          ),
        )
        .map((line) => [
          line.annotations["event"],
          line.annotations["session"],
        ]),
    ).toEqual([["session.passivated", second?.["id"]]])
    expect(JSON.parse(String(sessions(running)[0]?.["tasks"]))).toHaveLength(1)

    // The turn that was in flight all along ends as any other.
    await fakes.model.release(4)
    await fakes.chat.answers(held, 1)
    expect(await posted(running, held)).toEqual(["three"])
    expect(third?.["id"]).not.toBe(first?.["id"])
  },
)
