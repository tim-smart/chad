import { existsSync, readdirSync, readFileSync } from "node:fs"
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
