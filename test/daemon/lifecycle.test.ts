import { Duration } from "effect"
import { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import { defaults } from "../../dist/Timings.js"
import { scenario, type Scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { rows, says, sessions } from "../support/owner.ts"

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

/** A script that prints where a session's processes start and what their home is. */
const where =
  'console.log(JSON.stringify({ cwd: (await run("pwd")).trim(), home: (await run("printenv HOME")).trim() }))'

test(
  "IMG-36 STO-20 STO-22 a session's Agent starts in sessions/<session id>/ on the volume, and HOME is the volume's home/ for every session",
  { timeout: 15_000 },
  async () => {
    const running = await scenario()
    const { fakes } = running
    await fakes.model.script([
      runs(where),
      { text: "one" },
      runs(where),
      { text: "two" },
    ])
    const first = await fakes.chat.makeThread("direct")
    await says(running, first, "hello")
    await fakes.chat.answers(first, 1)
    const second = await fakes.chat.makeThread("direct")
    await says(running, second, "hello")
    await fakes.chat.answers(second, 1)

    const ids = sessions(running).map((session) => String(session["id"]))
    const calls = await fakes.model.calls()
    const printed = [calls[1], calls[3]].map((call) =>
      JSON.parse(String(results(call)[0])),
    )
    expect(printed).toEqual(
      ids.map((id) => ({
        cwd: `${running.data}/sessions/${id}`,
        home: `${running.data}/home`,
      })),
    )
  },
)

test("STO-62 STO-205 a session has one row with its id, thread, kind and times, clanka's environment, the system prompt last sent with its fingerprint, and the mark of the last message, and its history is one row a message in order", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "one" }])
  const thread = await fakes.chat.makeThread("direct")
  const before = Date.now()
  const hello = await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  await running.logged("turn.ended")

  const columns = (table: string) =>
    rows(running, `SELECT name FROM pragma_table_info('${table}')`).map(
      (column) => column["name"],
    )
  expect(columns("sessions")).toEqual([
    "id",
    "thread",
    "created_at",
    "kind",
    "ended_at",
    "environment",
    "system",
    "chunks",
    "generation",
    "fingerprint",
    "last_message_id",
    "last_message_at",
    "tasks",
  ])
  expect(columns("session_messages")).toEqual(["seq", "session_id", "message"])

  const all = sessions(running)
  expect(all).toHaveLength(1)
  const [session] = all
  expect(session).toMatchObject({
    thread: ChatThread.toString(thread),
    kind: "direct",
    ended_at: null,
    generation: 0,
    last_message_id: hello.message.id,
    tasks: "[]",
  })
  expect(session?.["id"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  expect(session?.["created_at"]).toBeGreaterThanOrEqual(before)
  expect(session?.["created_at"]).toBeLessThanOrEqual(Date.now())
  expect(Number.isInteger(session?.["last_message_at"])).toBe(true)
  expect(String(session?.["environment"])).toContain(
    `sessions/${String(session?.["id"])}`,
  )
  const [call] = await fakes.model.calls()
  expect(system(call)).toEqual([session?.["system"]])
  expect(session?.["fingerprint"]).toMatch(/^[0-9a-f]{64}$/)
  const history = rows(
    running,
    "SELECT seq, session_id, message FROM session_messages ORDER BY seq",
  )
  expect(history.map((row) => row["session_id"])).toEqual([
    session?.["id"],
    session?.["id"],
  ])
  expect(history.map((row) => JSON.parse(String(row["message"])).role)).toEqual(
    ["user", "assistant"],
  )
})

test(
  "SES-87 SES-92 SES-95 SES-96a SES-192 SWAP-22 FAIL-324 FAIL-325 TST-212 an idle session leaves memory after the idle time, and the next message restores it from SQLite: the same history, the same environment and the same system prompt, byte for byte",
  { timeout: 20_000 },
  async () => {
    expect(Duration.toMinutes(defaults.sessionIdle)).toBe(30)
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
    expect(results(calls[3]).at(-1)?.trim()).toBe(
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
