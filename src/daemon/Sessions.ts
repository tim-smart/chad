import { randomUUID } from "node:crypto"
import * as AgentExecutor from "clanka/AgentExecutor"
import { Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"

/**
 * What chad stores about sessions and turns: the `sessions` row, the history in `session_messages`, the record of
 * every turn in `turns` and of every message that steered one in `steers`. Nothing here deletes a `sessions`, a
 * `turns` or a `steers` row.
 */

const MessageJson = Schema.toCodecJson(Prompt.Message)
const encodeMessage = Schema.encodeSync(MessageJson)
const decodeMessage = Schema.decodeSync(MessageJson)
const EnvironmentJson = Schema.toCodecJson(AgentExecutor.ExecutionEnvironment)
const encodeEnvironment = Schema.encodeSync(EnvironmentJson)
const decodeEnvironment = Schema.decodeSync(EnvironmentJson)

/** A history message as its row holds it. The text of a message is worked out once, however often it is compared. */
const texts = new WeakMap<Prompt.Message, string>()
export const encode = (message: Prompt.Message): string => {
  let text = texts.get(message)
  if (text === undefined) {
    text = JSON.stringify(encodeMessage(message))
    texts.set(message, text)
  }
  return text
}

/** The text of a user message with string content, which is how clanka appends a steering message. */
export const textOf = (message: Prompt.Message) => {
  if (message.role !== "user" || message.content.length !== 1) return undefined
  const [part] = message.content
  return part?.type === "text" ? part.text : undefined
}

/**
 * Which of a turn's outstanding steers the messages of a reconcile carry: each steer, oldest first, takes the first
 * message with its text that comes after the message the steer before it took. Gives the indexes of those steers.
 */
export const matched = (
  outstanding: ReadonlyArray<string>,
  written: ReadonlyArray<string | undefined>,
): ReadonlyArray<number> => {
  const found: Array<number> = []
  let from = 0
  for (const [index, text] of outstanding.entries()) {
    const at = written.indexOf(text, from)
    if (at < 0) continue
    found.push(index)
    from = at + 1
  }
  return found
}

/** The kind of a session's thread, as a plugin sees it. */
export type Kind = "direct" | "channel" | "thread"

/** The last message chad handled in a thread: its id, and its time in milliseconds since the epoch. */
export interface Mark {
  readonly id: string
  readonly at: number
}

export interface Session {
  readonly id: string
  readonly thread: string
  readonly kind: Kind | null
  readonly environment: string | null
  readonly system: string | null
  readonly fingerprint: string | null
  readonly tasks: string
}

/** The session a thread has now, which is its one row that no `/new` has ended. */
export const current = Effect.fnUntraced(function* (thread: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<Session>`
    SELECT id, thread, kind, environment, system, fingerprint, tasks FROM sessions
    WHERE thread = ${thread} AND ended_at IS NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `
  return rows[0]
})

/** Whether a thread has ever had a session. */
export const known = Effect.fnUntraced(function* (thread: string) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT 1 FROM sessions WHERE thread = ${thread} LIMIT 1`
  return rows.length > 0
})

/**
 * Whether one mark is later than another. Two messages of one time are ordered by their ids: a longer id is later, and
 * ids of one length compare as text. Discord's ids and the local platform's both count up that way.
 */
export const later = (a: Mark, b: Mark) =>
  a.at !== b.at
    ? a.at > b.at
    : a.id.length !== b.id.length
      ? a.id.length > b.id.length
      : a.id > b.id

/** Starts a session in a thread, with a fresh id, and gives the id. */
export const open = Effect.fnUntraced(function* (
  thread: string,
  kind: Kind,
  mark?: Mark,
) {
  const sql = yield* SqlClient.SqlClient
  const id = randomUUID()
  yield* sql`
    INSERT INTO sessions (id, thread, kind, created_at, last_message_id, last_message_at)
    VALUES (${id}, ${thread}, ${kind}, ${Date.now()}, ${mark?.id ?? null}, ${mark?.at ?? null})
  `
  return id
})

/**
 * Ends the session a thread has, which only `/new` does, and starts the next one in the same transaction, so a
 * thread that had a session is never without one. The old row stays. Gives the new session's id.
 */
export const renew = Effect.fnUntraced(function* (
  thread: string,
  kind: Kind,
  mark: Mark,
) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // A message that was saved while the reset ran has moved the old row's mark, and the mark never goes back.
      const ended = yield* sql<{ id: string | null; at: number | null }>`
        UPDATE sessions SET ended_at = ${Date.now()} WHERE thread = ${thread} AND ended_at IS NULL
        RETURNING last_message_id AS id, last_message_at AS at
      `
      const last = ended.find(
        (row): row is Mark =>
          row.id !== null && row.at !== null && later(row as Mark, mark),
      )
      return yield* open(thread, kind, last ?? mark)
    }),
  )
})

/** Moves the mark of a thread's session to a message chad handled. The mark only moves forward. */
export const mark = Effect.fnUntraced(function* (thread: string, to: Mark) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE sessions SET last_message_id = ${to.id}, last_message_at = ${to.at}
    WHERE thread = ${thread} AND ended_at IS NULL AND (
      last_message_at IS NULL OR last_message_at < ${to.at} OR (
        last_message_at = ${to.at} AND (
          length(last_message_id) < length(${to.id}) OR (length(last_message_id) = length(${to.id}) AND last_message_id <= ${to.id})
        )
      )
    )
  `
})

/** The system prompt a session last sent, with the fingerprint of what chad rendered for it. */
export const freeze = Effect.fnUntraced(function* (
  id: string,
  system: string,
  fingerprint: string,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE sessions SET system = ${system}, fingerprint = ${fingerprint} WHERE id = ${id}`
})

/** The background tasks a session has running, as the JSON list of their ids and kinds. */
export const tasks = Effect.fnUntraced(function* (
  id: string,
  running: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE sessions SET tasks = ${JSON.stringify(running)} WHERE id = ${id}`
})

/** The rows of a session's stored history as they are written, oldest first. */
export const stored = Effect.fnUntraced(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    message: string
  }>`SELECT message FROM session_messages WHERE session_id = ${id} ORDER BY seq`
  return rows.map((row) => row.message)
})

/** The stored history of a session, oldest first. */
export const history = Effect.fnUntraced(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    message: string
  }>`SELECT message FROM session_messages WHERE session_id = ${id} ORDER BY seq`
  return rows.map((row) => decodeMessage(JSON.parse(row.message)))
})

export const environment = (stored: string) =>
  decodeEnvironment(JSON.parse(stored))

/** A message that joined a running turn, by the key of the request that carried it. */
export interface Steer {
  readonly key: string
  readonly turn: string
}

const write = Effect.fnUntraced(function* (
  id: string,
  messages: ReadonlyArray<Prompt.Message>,
  executor: AgentExecutor.ExecutionEnvironment,
  steers: ReadonlyArray<Steer>,
) {
  const sql = yield* SqlClient.SqlClient
  for (const message of messages) {
    yield* sql`INSERT INTO session_messages (session_id, message) VALUES (${id}, ${encode(message)})`
  }
  for (const steer of steers) {
    yield* sql`INSERT OR IGNORE INTO steers (request_key, turn_id) VALUES (${steer.key}, ${steer.turn})`
  }
  yield* sql`UPDATE sessions SET environment = ${JSON.stringify(encodeEnvironment(executor))} WHERE id = ${id}`
})

/**
 * Stores one batch of history in one transaction, with clanka's environment as it stands and the `steers` rows of
 * the steering messages the batch carries.
 */
export const append = Effect.fnUntraced(function* (
  id: string,
  messages: ReadonlyArray<Prompt.Message>,
  executor: AgentExecutor.ExecutionEnvironment,
  steers: ReadonlyArray<Steer> = [],
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(write(id, messages, executor, steers))
})

/** Swaps the whole stored history of a session in one transaction, which is what a compaction does. */
export const replace = Effect.fnUntraced(function* (
  id: string,
  messages: ReadonlyArray<Prompt.Message>,
  executor: AgentExecutor.ExecutionEnvironment,
  steers: ReadonlyArray<Steer> = [],
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(
    Effect.andThen(
      sql`DELETE FROM session_messages WHERE session_id = ${id}`,
      write(id, messages, executor, steers),
    ),
  )
})

export interface Turn {
  readonly request_key: string
  readonly turn_id: string | null
  readonly outcome: "answered" | "failed" | "stopped" | null
  readonly failure: string | null
}

/** The row of the turn a request asked for, when there is one. */
export const turn = Effect.fnUntraced(function* (key: string) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql<Turn>`SELECT request_key, turn_id, outcome, failure FROM turns WHERE request_key = ${key}`
  return rows[0]
})

/** A turn id: `t_` and twelve hex digits. */
export const turnId = () => `t_${randomUUID().replaceAll("-", "").slice(0, 12)}`

/**
 * Records that a turn starts, and gives what the request's earlier attempts used. The row keeps the id of the
 * request's first attempt, and a later attempt counts one more start and takes the session and the model it runs with.
 */
export const started = Effect.fnUntraced(function* (start: {
  readonly key: string
  readonly turn: string
  readonly session: string
  readonly model: string | undefined
  readonly at: number
}) {
  const sql = yield* SqlClient.SqlClient
  const earlier = yield* sql<Usage>`
    SELECT input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheRead,
      cache_write_tokens AS cacheWrite, context_tokens AS contextTokens
    FROM turns WHERE request_key = ${start.key}
  `
  yield* sql`
    INSERT INTO turns (request_key, turn_id, session_id, origin, started_at, starts, model)
    VALUES (${start.key}, ${start.turn}, ${start.session}, 'message', ${start.at}, 1, ${start.model ?? null})
    ON CONFLICT (request_key) DO UPDATE SET
      starts = starts + 1, session_id = excluded.session_id, model = excluded.model
  `
  return earlier[0] ?? noUsage
})

/** Whether a message joined a running turn, which its `steers` row says. */
export const steered = Effect.fnUntraced(function* (key: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT 1 FROM steers WHERE request_key = ${key}`
  return rows.length > 0
})

/** What a turn has used so far. The four counters are running totals of the turn, sub-agents included. */
export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly contextTokens: number
}

export const noUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  contextTokens: 0,
}

/** A turn's usage as the fields of a log line, which carry the names of the `turns` columns. */
export const fields = (used: Usage) => ({
  input_tokens: used.inputTokens,
  output_tokens: used.outputTokens,
  cache_read_tokens: used.cacheRead,
  cache_write_tokens: used.cacheWrite,
  context_tokens: used.contextTokens,
})

export const usage = Effect.fnUntraced(function* (key: string, used: Usage) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE turns SET
      input_tokens = ${used.inputTokens}, output_tokens = ${used.outputTokens},
      cache_read_tokens = ${used.cacheRead}, cache_write_tokens = ${used.cacheWrite},
      context_tokens = ${used.contextTokens}
    WHERE request_key = ${key}
  `
})

/** Records how a turn ended. */
export const ended = Effect.fnUntraced(function* (end: {
  readonly key: string
  readonly outcome: "answered" | "failed" | "stopped"
  readonly failure?: string | undefined
  readonly at: number
}) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE turns SET ended_at = ${end.at}, outcome = ${end.outcome}, failure = ${end.failure ?? null}
    WHERE request_key = ${end.key}
  `
})
