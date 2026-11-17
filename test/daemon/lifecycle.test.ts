import { Duration } from "effect"
import { expect, test } from "vitest"
import { scenario, type Scenario } from "../support/driver.ts"
import { printed, runs } from "../support/model.ts"
import { says, sessions } from "../support/owner.ts"

/** The system prompt a model call carries. */
const system = (call: { readonly body: unknown } | undefined) => {
  const body = call?.body as
    { messages: ReadonlyArray<{ role: string; content: unknown }> } | undefined
  return (body?.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => message.content)
}

/** The lines of one event that a scenario has logged so far. */
const lines = (running: Scenario, event: string) =>
  running.log().filter((line) => line.annotations["event"] === event)

test(
  "an idle session leaves memory after the idle time, and the next message restores it from SQLite: the same history, the same environment and the same system prompt, byte for byte",
  { timeout: 20_000 },
  async () => {
    // Cluster looks for idle entities every five seconds at the least, so the session leaves memory at its next look.
    const running = await scenario({
      timings: { sessionIdle: Duration.millis(300) },
    })
    const { fakes } = running
    await fakes.model.script([
      runs('await run("mkdir -p work"); await changeDirectory("work")'),
      { text: "one" },
      runs('console.log((await run("pwd")).trim())'),
      { text: "two" },
    ])
    const thread = await fakes.chat.makeThread("direct")
    await says(running, thread, "remember the word heron")
    await fakes.chat.answers(thread, 1)
    const [session] = sessions(running)
    const id = String(session?.["id"])
    expect(lines(running, "session.restored")).toEqual([])

    const passivated = await running.logged("session.passivated")
    expect(passivated.level).toBe("INFO")
    expect(passivated.annotations["session"]).toBe(id)
    const frozen = sessions(running)[0]

    await says(running, thread, "which word")
    await fakes.chat.answers(thread, 2)
    const restored = await running.logged("session.restored")
    expect(restored.level).toBe("INFO")
    expect(restored.annotations).toMatchObject({ session: id, messages: 4 })
    expect(sessions(running)).toHaveLength(1)

    const calls = await fakes.model.calls()
    expect(calls).toHaveLength(4)
    // The history clanka sends is the one that was stored, and the script starts where the last one left.
    expect(JSON.stringify(calls[2]?.body)).toContain("remember the word heron")
    expect(printed(calls[3]).at(-1)?.trim()).toBe(
      `${running.data}/sessions/${id}/work`,
    )
    // The prompt is the frozen one, and the row still holds it under the same fingerprint.
    expect(system(calls[2])).toEqual(system(calls[0]))
    expect(system(calls[2])).toEqual([frozen?.["system"]])
    expect(sessions(running)[0]).toMatchObject({
      system: frozen?.["system"],
      fingerprint: frozen?.["fingerprint"],
    })

    // A daemon that stops takes the session out of memory too.
    const count = lines(running, "session.passivated").length
    await running.stop()
    expect(lines(running, "session.passivated")).toHaveLength(count + 1)
  },
)
