import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Duration, Effect } from "effect"
import { ChatError, ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import { execute } from "../support/database.ts"
import { owner, scenario, type Scenario } from "../support/driver.ts"
import { runs } from "../support/model.ts"
import {
  eventually,
  found,
  lines,
  posted,
  prompted,
  rows,
  says,
  sessions,
  stoppedNotices,
} from "../support/owner.ts"

/** The replies cluster holds, by their tag, in the order they were saved. */
const replies = (running: Scenario) =>
  rows(
    running,
    `SELECT r.payload FROM cluster_replies r JOIN cluster_messages m ON m.id = r.request_id
     WHERE m.tag = 'message' ORDER BY r.rowid`,
  ).map((row) => String(JSON.parse(String(row["payload"])).value._tag))

/** The replies to the owner's messages, apart from the ones cluster makes for itself. */
const answered = `SELECT 1 FROM cluster_replies r JOIN cluster_messages m ON m.id = r.request_id WHERE m.tag = 'message'`

/**
 * An owner's message that waits to steer the running turn. It carries a file, and chad saves a steering message's
 * file before the message joins the turn, so the file says that the message has reached the turn. A stored request
 * reaches its session later than a command does, which is not stored.
 */
const waits = async (running: Scenario, thread: ChatThread.ChatThread) => {
  const event = await says(running, thread, "never read", {
    files: [
      {
        name: "note.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("a note"),
      },
    ],
  })
  const [session] = sessions(running)
  const inbox = join(running.data, "sessions", String(session?.["id"]), "inbox")
  await eventually(
    () => (existsSync(inbox) ? readdirSync(inbox) : []),
    (files) => files.length > 0,
  )
  return event
}

/** The text of every user message in a session's stored history. */
const stored = (running: Scenario, session: unknown) =>
  rows(
    running,
    `SELECT message FROM session_messages WHERE session_id = '${String(session)}' ORDER BY seq`,
  )
    .map((row) => JSON.parse(String(row["message"])))
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part: { text?: string }) => part.text).join(""),
    )

test("two messages sent during a turn join it as one batch, each gets a steers row and a turn.steered line before it is answered Steered, and the session never has a second send", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    { ...runs('console.log("ran")'), hold: true },
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(1)
  const first = await says(running, thread, "first steer")
  const second = await says(running, thread, "second steer")
  // The three requests are open at once, and nothing is answered or recorded while the turn has not read them.
  expect(rows(running, "SELECT * FROM steers")).toEqual([])
  expect(replies(running)).toEqual([])

  await fakes.model.release(0)
  await fakes.chat.answers(thread, 1)
  await found(running, answered, 3)

  // One turn, and one model call after the script: the batch went into the turn that was running.
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(2)
  const body = calls[1]?.body as {
    messages: ReadonlyArray<{ role: string; content: unknown }>
  }
  expect(
    body.messages.slice(-2).map((message) => [message.role, message.content]),
  ).toEqual([
    ["user", "first steer"],
    ["user", "second steer"],
  ])
  const turns = rows(running, "SELECT request_key, turn_id, outcome FROM turns")
  expect(turns).toMatchObject([{ outcome: "answered" }])
  const turn = turns[0]?.["turn_id"]
  expect(
    rows(running, "SELECT turn_id FROM steers").map((row) => row["turn_id"]),
  ).toEqual([turn, turn])
  const keys = rows(
    running,
    "SELECT request_key FROM steers ORDER BY rowid",
  ).map((row) => String(row["request_key"]))
  expect(keys[0]).toContain(first.message.id)
  expect(keys[1]).toContain(second.message.id)
  expect(keys).not.toContain(turns[0]?.["request_key"])

  const lines = running
    .log()
    .filter((line) => line.annotations["event"] === "turn.steered")
  expect(lines.map((line) => line.annotations["turn"])).toEqual([turn, turn])
  expect(lines.map((line) => line.level)).toEqual(["INFO", "INFO"])
  expect(replies(running).toSorted()).toEqual([
    "Answered",
    "Steered",
    "Steered",
  ])
  // Each message is in the stored history once, and chad posted the one answer.
  const [session] = sessions(running)
  expect(stored(running, session?.["id"])).toEqual([
    "hello",
    "first steer",
    "second steer",
  ])
  expect(await posted(running, thread)).toEqual(["done"])
})

test("a message that arrives when the turn's model part is over starts the next turn by the same request, and its image goes to the model as on a first message", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([{ text: "one", hold: true }, { text: "two" }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  // The answer's post is refused once, which holds the turn open after its model part.
  await fakes.model.received(1)
  await Effect.runPromise(
    chat.failNext(
      "post",
      new ChatError.RateLimited({ retryAfter: Duration.millis(400) }),
    ),
  )
  const before = (await Effect.runPromise(chat.calls)).length
  await fakes.model.release(0)
  await eventually(
    () => Effect.runPromise(chat.calls),
    (calls) => calls.slice(before).some((call) => call.op === "post"),
  )
  await says(running, thread, "later", {
    files: [
      {
        name: "dot.png",
        contentType: "image/png",
        content: new Uint8Array([137, 80, 78, 71]),
      },
    ],
  })
  await fakes.chat.answers(thread, 2)
  await found(running, answered, 2)

  expect(await posted(running, thread)).toEqual(["one", "two"])
  expect(
    rows(running, "SELECT outcome FROM turns ORDER BY started_at"),
  ).toEqual([{ outcome: "answered" }, { outcome: "answered" }])
  expect(rows(running, "SELECT * FROM steers")).toEqual([])
  expect(replies(running)).toEqual(["Answered", "Answered"])
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(2)
  expect(JSON.stringify(calls[1]?.body)).toContain(
    Buffer.from([137, 80, 78, 71]).toString("base64"),
  )
  const [session] = sessions(running)
  expect(
    existsSync(
      join(running.data, "sessions", String(session?.["id"]), "inbox"),
    ),
  ).toBe(false)
})

test("/stop interrupts the turn, which ends as Stopped with its notice and no failure, the message that waited to steer it is Dropped, and the session takes the next turn with its history", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    { ...runs('console.log("ran")'), hold: true },
    { text: "after the stop" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(1)
  await waits(running, thread)
  await says(running, thread, "/stop")
  const [notice] = await fakes.chat.answers(thread, 1)
  await found(running, answered, 2)

  expect(
    stoppedNotices((milliseconds) =>
      Messages.stopped(Format.local, milliseconds),
    ),
  ).toContain(notice?.text)
  const [turn] = rows(running, "SELECT outcome, ended_at, failure FROM turns")
  expect(turn).toMatchObject({ outcome: "stopped", failure: null })
  expect(turn?.["ended_at"]).toEqual(expect.any(Number))
  expect(replies(running).toSorted()).toEqual(["Dropped", "Stopped"])
  expect(rows(running, "SELECT * FROM steers")).toEqual([])
  const ended = await running.logged("turn.ended")
  expect(ended.annotations["outcome"]).toBe("stopped")
  expect(
    running.log().filter((line) => line.annotations["event"] === "turn.failed"),
  ).toEqual([])
  // The stop is no stored request: cluster holds the two messages and nothing else.
  expect(
    rows(
      running,
      "SELECT tag FROM cluster_messages WHERE tag NOT LIKE 'Cluster/%' AND entity_type NOT LIKE 'ClusterCron/%'",
    ).map((row) => row["tag"]),
  ).toEqual(["message", "message"])

  // The same session takes the next turn, with what the stopped turn left in its history.
  await says(running, thread, "next")
  await fakes.chat.answers(thread, 2)
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(2)
  const sent = JSON.stringify(calls[1]?.body)
  expect(sent).toContain("hello")
  expect(sent).not.toContain("never read")
  expect(prompted(calls[1])).toBe("next")
  expect(sessions(running)).toHaveLength(1)
})

test("/new ends the session's row and starts a new session in the thread with its own id and directory, the next message runs in it, and the command leaves a command.ran line", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "one" }, { text: "two" }])
  const thread = await fakes.chat.makeThread("direct")
  const hello = await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  const [before] = sessions(running)
  expect(before).toMatchObject({
    ended_at: null,
    last_message_id: hello.message.id,
  })

  // The message is sent straight after the command, and still belongs to the new session.
  await says(running, thread, "/new")
  const again = await says(running, thread, "again")
  await fakes.chat.answers(thread, 3)
  expect(await posted(running, thread)).toEqual([
    "one",
    Messages.newSession(Format.local),
    "two",
  ])

  const [old, fresh] = sessions(running)
  expect(sessions(running)).toHaveLength(2)
  expect(old).toMatchObject({ id: before?.["id"], thread: before?.["thread"] })
  expect(old?.["ended_at"]).toEqual(expect.any(Number))
  expect(fresh).toMatchObject({
    thread: ChatThread.toString(thread),
    kind: "direct",
    ended_at: null,
    last_message_id: again.message.id,
  })
  expect(fresh?.["id"]).not.toBe(old?.["id"])
  expect(
    rows(running, "SELECT session_id FROM turns ORDER BY started_at").map(
      (row) => row["session_id"],
    ),
  ).toEqual([old?.["id"], fresh?.["id"]])
  // The new session has none of the old conversation, and a directory of its own.
  expect(JSON.stringify((await fakes.model.calls())[1]?.body)).not.toContain(
    "hello",
  )
  for (const session of [old, fresh]) {
    expect(
      existsSync(join(running.data, "sessions", String(session?.["id"]))),
    ).toBe(true)
  }
  // The reset is not a stored request.
  expect(
    rows(
      running,
      "SELECT tag FROM cluster_messages WHERE tag NOT LIKE 'Cluster/%' AND entity_type NOT LIKE 'ClusterCron/%'",
    ).map((row) => row["tag"]),
  ).toEqual(["message", "message"])

  const ran = await running.logged("command.ran")
  expect(ran.annotations).toMatchObject({
    command: "/new",
    caller: "owner",
    outcome: "changed",
    session: fresh?.["id"],
  })
  // /stop and /status change nothing, and leave no such line. Each still moves the mark.
  const stop = await says(running, thread, "/stop")
  expect(sessions(running)[1]?.["last_message_id"]).toBe(stop.message.id)
  const status = await says(running, thread, "/status")
  expect(sessions(running)[1]?.["last_message_id"]).toBe(status.message.id)
  expect(
    running.log().filter((line) => line.annotations["event"] === "command.ran"),
  ).toHaveLength(1)
})

test("/new during a turn stops it first, posts the stopped notice and then its own, drops the message that waited to steer, and stops the old session's background processes", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    runs(
      `await bash({ command: "echo $$ > pid; exec sleep 30", background: true })`,
    ),
    { text: "held", hold: true },
    { text: "in the new session" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(2)
  const [old] = sessions(running)
  const file = join(running.data, "sessions", String(old?.["id"]), "pid")
  const pid = Number(readFileSync(file, "utf8"))
  expect(() => process.kill(pid, 0)).not.toThrow()

  await waits(running, thread)
  await says(running, thread, "/new")
  const notices = await fakes.chat.answers(thread, 2)
  expect(
    stoppedNotices((milliseconds) =>
      Messages.stopped(Format.local, milliseconds),
    ),
  ).toContain(notices[0]?.text)
  expect(notices[1]?.text).toBe(Messages.newSession(Format.local))
  await found(running, answered, 2)
  expect(replies(running).toSorted()).toEqual(["Dropped", "Stopped"])
  expect(rows(running, "SELECT outcome FROM turns")).toEqual([
    { outcome: "stopped" },
  ])
  // The process the old session started in the background is gone.
  await eventually(
    () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    (alive) => !alive,
  )

  await says(running, thread, "again")
  await fakes.chat.answers(thread, 3)
  expect(sessions(running)).toHaveLength(2)
})

test("a turn stays open while a background sub-agent runs after the model has answered, and a message sent meanwhile steers that turn", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    // The turn's script waits until the sub-agent's script runs, so the sub-agent's call is the second one.
    runs(
      `await run("mkfifo ready gate"); await subagent({ prompt: "Wait.", background: true }); await run("cat ready")`,
    ),
    // The sub-agent's one call: its script says that it runs, and then waits for the scenario.
    runs(
      `await run("echo go > ready; cat gate"); await taskComplete("waited")`,
    ),
    { text: "answered while it runs" },
    { text: "read the message" },
    { text: "the end" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(3)
  // The model has answered, and the turn has not ended.
  expect(rows(running, "SELECT outcome FROM turns")).toEqual([
    { outcome: null },
  ])
  expect(await posted(running, thread)).toEqual([])

  await says(running, thread, "are you there")
  const calls = await fakes.model.received(4)
  expect(prompted(calls[3])).toBe("are you there")
  await found(running, "SELECT 1 FROM steers")
  expect(rows(running, "SELECT outcome FROM turns")).toEqual([
    { outcome: null },
  ])

  // The sub-agent ends, and the turn with it.
  const [session] = sessions(running)
  writeFileSync(
    join(running.data, "sessions", String(session?.["id"]), "gate"),
    "go",
  )
  await fakes.chat.answers(thread, 1)
  expect(
    await found(running, "SELECT outcome FROM turns WHERE outcome IS NOT NULL"),
  ).toEqual([{ outcome: "answered" }])
  expect(rows(running, "SELECT 1 FROM turns")).toHaveLength(1)
})

test("a stop whose reconcile writes a lost row of an earlier turn again does not take that row for a steer the Agent never read, though their text is the same", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    { text: "one" },
    { text: "never sent", hold: true },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "same text")
  await fakes.chat.answers(thread, 1)
  await says(running, thread, "more")
  await fakes.model.received(2)
  await says(running, thread, "same text")
  // The message with a file is sent after it, so once its file is saved the one before it waits as well.
  await waits(running, thread)
  // The first turn's prompt goes missing, so the reconcile writes the whole history again.
  execute(
    running.data,
    "DELETE FROM session_messages WHERE seq = (SELECT min(seq) FROM session_messages)",
  )
  await says(running, thread, "/stop")
  await found(running, answered, 4)

  const ended = await lines(running, "turn.ended", 2)
  expect(ended[1]?.annotations["outcome"]).toBe("stopped")
  expect(ended[1]?.annotations["reconciled"]).toBeGreaterThan(0)
  expect(replies(running).toSorted()).toEqual([
    "Answered",
    "Dropped",
    "Dropped",
    "Stopped",
  ])
  expect(rows(running, "SELECT * FROM steers")).toEqual([])
  expect(
    running
      .log()
      .filter((line) => line.annotations["event"] === "turn.steered"),
  ).toEqual([])
  const [session] = sessions(running)
  expect(stored(running, session?.["id"])).toEqual(["same text", "more"])
})

test("a message handled while /new is finishing, with the same time as the command, is the new session's mark, because two messages of one time are ordered by their ids", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([{ text: "one", hold: true }, { text: "two" }])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(1)
  // The stop's notice waits on a rate limit, which holds the reset open.
  await Effect.runPromise(
    chat.failNext(
      "post",
      new ChatError.RateLimited({ retryAfter: Duration.millis(400) }),
    ),
  )
  const reset = await says(running, thread, "/new")
  const posted = await fakes.chat.userPosts(thread, {
    text: "again",
    authorId: owner,
  })
  if (posted._tag !== "MessageCreated") throw new Error("not a message")
  const again = {
    ...posted,
    message: { ...posted.message, timestamp: reset.message.timestamp },
  }
  expect(await fakes.chat.deliver(again)).toBe(true)
  await fakes.chat.answers(thread, 3)

  const [old, fresh] = sessions(running)
  // The message was handled before the reset ended the old row, and the new row starts from it and not from the command.
  expect(old?.["last_message_id"]).toBe(again.message.id)
  expect(fresh).toMatchObject({
    ended_at: null,
    last_message_id: again.message.id,
    last_message_at: old?.["last_message_at"],
  })
})
