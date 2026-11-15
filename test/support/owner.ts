// What an owner does in a scenario, and what a scenario reads back of the sessions.
import { ChatThread } from "effect/chat"
import { expect } from "vitest"
import { query } from "./database.ts"
import { owner, type Scenario } from "./driver.ts"
import type { File } from "./fakes.ts"

/** An owner's message, delivered to the daemon, which accepts it. */
export const says = async (
  { fakes }: Scenario,
  thread: ChatThread.ChatThread,
  text: string,
  options: {
    readonly mention?: boolean
    readonly files?: ReadonlyArray<File>
  } = {},
) => {
  const event = await fakes.chat.userPosts(thread, {
    text,
    authorId: owner,
    mentionsSelf: options.mention,
    files: options.files,
  })
  expect(await fakes.chat.deliver(event)).toBe(true)
  if (event._tag !== "MessageCreated") throw new Error("not a message")
  return event
}

/** The rows of a read-only statement, with every integer as a number. */
export const rows = (
  { data }: Scenario,
  sql: string,
): ReadonlyArray<Record<string, unknown>> =>
  query(data, sql).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, value]) => [
        name,
        typeof value === "bigint" ? Number(value) : value,
      ]),
    ),
  )

/** The `sessions` rows of a scenario, oldest first. */
export const sessions = (running: Scenario) =>
  rows(running, "SELECT * FROM sessions ORDER BY created_at, rowid")

/** The thread a `sessions` row names. */
export const threadOf = (row: Record<string, unknown> | undefined) => {
  const thread = ChatThread.fromString(String(row?.["thread"]))
  if (thread._tag === "None") throw new Error("not a thread")
  return thread.value
}

/** The text of every message chad has posted in a thread. */
export const posted = async (
  { fakes }: Scenario,
  thread: ChatThread.ChatThread,
) =>
  (await fakes.chat.messages(thread))
    .filter((message) => message.author.isSelf)
    .map((message) => message.text)

/** The text of the last user message a model call carries. */
export const prompted = (call: { readonly body: unknown } | undefined) => {
  const body = call?.body as
    | { messages?: ReadonlyArray<{ role?: string; content?: unknown }> }
    | undefined
  const last = (body?.messages ?? []).findLast(
    (message) => message.role === "user",
  )
  return typeof last?.content === "string"
    ? last.content
    : JSON.stringify(last?.content)
}

/** Reads until what is read is what the scenario waits for, and gives it. The scenario's own timeout is the limit. */
export const eventually = async <A>(
  read: () => A | Promise<A>,
  done: (value: A) => boolean,
): Promise<A> => {
  for (;;) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Waits until a statement gives at least a number of rows, and gives them. */
export const found = (running: Scenario, sql: string, count = 1) =>
  eventually(
    () => rows(running, sql),
    (all) => all.length >= count,
  )

/** Waits until a number of lines of one event are logged, and gives them. */
export const lines = (running: Scenario, event: string, count: number) =>
  eventually(
    () => running.log().filter((line) => line.annotations["event"] === event),
    (all) => all.length >= count,
  )

/** The stopped notice of a turn that ran for a few seconds at the most, by its name in the Messages module. */
export const stoppedNotices = (stopped: (milliseconds: number) => string) =>
  [0, 1, 2, 3, 4, 5].map((seconds) => stopped(seconds * 1000))
