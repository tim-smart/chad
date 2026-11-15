import { randomUUID } from "node:crypto"
import * as AgentExecutor from "clanka/AgentExecutor"
import { Data, Effect, Schema } from "effect"
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

/** The kind of the session a thread has now, or `undefined` when it has none. */
export const kindOf = Effect.fnUntraced(function* (thread: string) {
  return (yield* current(thread))?.kind ?? undefined
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
  // A turn's prompt is recorded with the batch that stores it, so the record outlives a compaction that drops the
  // message itself (STO-207).
  for (const message of messages) {
    const key = requestOf(message)
    if (key !== undefined) {
      yield* sql`INSERT OR IGNORE INTO prompts (request_key, session_id) VALUES (${key}, ${id})`
    }
    // The lines an update message told are cleared with the batch that stores it, so a crash can neither lose them
    // nor have them told twice (FAIL-215, STO-132).
    const told = updatesOf(message)
    if (told !== undefined) {
      yield* sql`DELETE FROM session_updates WHERE session_id = ${id} AND seq <= ${told}`
    }
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
  readonly failure_detail: string | null
}

/** The row of the turn a request asked for, when there is one. */
export const turn = Effect.fnUntraced(function* (key: string) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql<Turn>`SELECT request_key, turn_id, outcome, failure, failure_detail FROM turns WHERE request_key = ${key}`
  return rows[0]
})

/** A turn id: `t_` and twelve hex digits. */
export const turnId = () => `t_${randomUUID().replaceAll("-", "").slice(0, 12)}`

/** A start of a turn as its row records it, with what the request's earlier attempts used. */
export interface Start {
  /** The turn id of the request's first attempt, which every later attempt keeps. */
  readonly turn: string
  /** How many times chad has started the turn, this start included. */
  readonly starts: number
  /** How many of the earlier starts a graceful stop cut. */
  readonly cuts: number
  readonly earlier: Usage
  /** The id of the status message an earlier start posted, which this one edits (STO-75, SES-104). */
  readonly status: string | undefined
  /** When the request's first attempt started. */
  readonly at: number
}

/** How many of a turn's earlier starts ended in a kill: every one that neither finished nor was cut gracefully. */
export const kills = (start: Start) => start.starts - 1 - start.cuts

/**
 * Records that a turn starts, and gives what the row holds after it. The row keeps the id and origin of the request's
 * first attempt, and a later attempt counts one more start and takes the session and the model it runs with.
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
  const rows = yield* sql<{
    turn_id: string
    starts: number
    graceful_cuts: number
    status_message_id: string | null
    started_at: number | null
  }>`
    INSERT INTO turns (request_key, turn_id, session_id, origin, started_at, starts, model)
    VALUES (${start.key}, ${start.turn}, ${start.session}, 'message', ${start.at}, 1, ${start.model ?? null})
    ON CONFLICT (request_key) DO UPDATE SET
      starts = starts + 1, session_id = excluded.session_id, model = excluded.model
    RETURNING turn_id, starts, graceful_cuts, status_message_id, started_at
  `
  const row = rows[0]!
  return {
    turn: row.turn_id,
    starts: row.starts,
    cuts: row.graceful_cuts,
    earlier: earlier[0] ?? noUsage,
    status: row.status_message_id ?? undefined,
    at: Number(row.started_at ?? start.at),
  } satisfies Start
})

/** Records the id of a turn's status message as soon as its post returns, so that a resumed start edits it (DIS-90). */
export const status = Effect.fnUntraced(function* (key: string, id: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE turns SET status_message_id = ${id} WHERE request_key = ${key}`
})

/** Records that a graceful stop cut a turn's start, which then does not count as a kill. */
export const cut = Effect.fnUntraced(function* (key: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE turns SET graceful_cuts = graceful_cuts + 1 WHERE request_key = ${key}`
})

/**
 * The options that mark the prompt of a turn with the key of its request. They are stored with the message, and a
 * provider reads only options under its own name, so the model never sees them.
 */
export const promptOf = (key: string) => ({ chad: { request: key } })

/** What chad's own options on a message hold under one name. */
const ownOption = (message: Prompt.Message, name: string): unknown => {
  const options: unknown = message.options["chad"]
  if (typeof options !== "object" || options === null) return undefined
  return (options as Readonly<Record<string, unknown>>)[name]
}

/** The request key that marks a message as a turn's prompt, when it is one. */
const requestOf = (message: Prompt.Message): string | undefined => {
  const request = ownOption(message, "request")
  return typeof request === "string" ? request : undefined
}

/** The options that mark an update message with the last `session_updates` line it tells. */
export const updateOf = (seq: number) => ({ chad: { updates: seq } })

const updatesOf = (message: Prompt.Message): number | undefined => {
  const seq = ownOption(message, "updates")
  return typeof seq === "number" ? seq : undefined
}

/**
 * Whether the stored history took the prompt of a turn at some point, which it has not when a kill came before the
 * prompt was stored (SES-161). A compaction since then does not change the answer (STO-207).
 */
export const holds = Effect.fnUntraced(function* (key: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    found: number
  }>`SELECT 1 AS found FROM prompts WHERE request_key = ${key}`
  return rows.length > 0
})

/**
 * Whether the volume shows neither that a turn's prompt was stored nor that it was not (STO-211). Such a turn's delivery
 * starts nothing until Tim rules on it.
 */
export const unproven = Effect.fnUntraced(function* (key: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    found: number
  }>`SELECT 1 AS found FROM unproven WHERE request_key = ${key}`
  return rows.length > 0
})

/**
 * Records that a chat command runs, by the dedupe key of its event, and says whether it is the first time. A command
 * whose key is recorded already, in this process or before a restart, does not run again (SES-203, SES-204).
 */
export const claim = Effect.fnUntraced(function* (key: string, thread: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ event_key: string }>`
    INSERT INTO commands (event_key, thread, ran_at) VALUES (${key}, ${thread}, ${Date.now()})
    ON CONFLICT (event_key) DO NOTHING
    RETURNING event_key
  `
  return rows.length > 0
})

/**
 * The request of a turn that a restart cut in a thread's current session: a `turns` row that has no outcome. It takes
 * the session before any other request of the thread (SES-200). A turn in `unproven` does not (STO-211).
 */
export const unfinished = Effect.fnUntraced(function* (thread: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ request_key: string }>`
    SELECT t.request_key FROM turns t JOIN sessions s ON s.id = t.session_id
    WHERE s.thread = ${thread} AND s.ended_at IS NULL AND t.outcome IS NULL
      AND t.request_key NOT IN (SELECT request_key FROM unproven)
    ORDER BY t.started_at LIMIT 1
  `
  return rows[0]?.request_key
})

/**
 * The sessions that the catch-up after a fresh identify reads forward in: each one that has not ended and whose last
 * handled owner message is younger than `window`, with the kind of its thread and that message's id (SES-37, SES-199).
 */
export const active = Effect.fnUntraced(function* (since: number) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{
    thread: string
    kind: Kind | null
    last_message_id: string
  }>`
    SELECT thread, kind, last_message_id FROM sessions
    WHERE ended_at IS NULL AND last_message_id IS NOT NULL AND last_message_at >= ${since}
  `
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

/** A line to tell the model, as `session_updates` holds it (STO-170). */
export type Line =
  | {
      readonly turn: string
      readonly outcome: "answered" | "failed" | "stopped"
      readonly failure?: string | undefined
    }
  | { readonly notice: string; readonly text: string }

const insertLine = Effect.fnUntraced(function* (session: string, line: Line) {
  const sql = yield* SqlClient.SqlClient
  const fields =
    "turn" in line
      ? {
          turn: line.turn,
          outcome: line.outcome,
          failure: line.failure ?? null,
          notice: null,
          text: null,
        }
      : {
          turn: null,
          outcome: null,
          failure: null,
          notice: line.notice,
          text: line.text,
        }
  yield* sql`
    INSERT INTO session_updates (session_id, seq, turn_id, outcome, failure, notice_key, text)
    SELECT ${session}, COALESCE(MAX(seq), 0) + 1, ${fields.turn}, ${fields.outcome}, ${fields.failure},
      ${fields.notice}, ${fields.text}
    FROM session_updates WHERE session_id = ${session}
  `
})

/**
 * Adds a line that the session's next turn tells the model (FAIL-131): a post of chad's in the thread that the
 * session's history does not hold.
 */
export const tell = Effect.fnUntraced(function* (session: string, line: Line) {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(insertLine(session, line))
})

/**
 * The lines that wait to be told to a session's model, oldest first, with the sequence number of the last. When a turn
 * waits to be told, the lines start with the session's other turns since the last answer the owner read, whose lines
 * an earlier update message told and cleared (FAIL-127). Those come from `turns`, so the clearing stays one
 * transaction with the history (FAIL-215).
 */
export const updates = Effect.fnUntraced(function* (session: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    seq: number
    turn_id: string | null
    outcome: "answered" | "failed" | "stopped" | null
    failure: string | null
    notice_key: string | null
    text: string | null
  }>`
    SELECT seq, turn_id, outcome, failure, notice_key, text FROM session_updates
    WHERE session_id = ${session} ORDER BY seq
  `
  const lines = rows.map((row): Line =>
    row.turn_id !== null && row.outcome !== null
      ? {
          turn: row.turn_id,
          outcome: row.outcome,
          failure: row.failure ?? undefined,
        }
      : { notice: row.notice_key ?? "", text: row.text ?? "" },
  )
  const last = rows.at(-1)?.seq
  const waiting = new Set(
    lines.flatMap((line) => ("turn" in line ? [line.turn] : [])),
  )
  if (waiting.size === 0) return { lines, last }
  // The last answer the owner read: the latest answered turn that is not an unposted answer still to be told.
  const answered = yield* sql<{ turn_id: string; ended_at: number }>`
    SELECT turn_id, ended_at FROM turns WHERE session_id = ${session} AND outcome = 'answered'
    ORDER BY ended_at DESC, rowid DESC LIMIT ${waiting.size + 1}
  `
  const read = answered.find((row) => !waiting.has(row.turn_id))
  const earlier = yield* sql<{
    turn_id: string
    outcome: "failed" | "stopped"
    failure: string | null
  }>`
    SELECT turn_id, outcome, failure FROM turns
    WHERE session_id = ${session} AND outcome IN ('failed', 'stopped') AND ended_at > ${read?.ended_at ?? -1}
    ORDER BY ended_at, rowid
  `
  // A turn whose thread was gone had nothing posted, so it was never told.
  const older = earlier
    .filter((row) => !waiting.has(row.turn_id) && row.failure !== "ThreadGone")
    .map((row): Line => ({
      turn: row.turn_id,
      outcome: row.outcome,
      failure: row.failure ?? undefined,
    }))
  return { lines: [...older, ...lines], last }
})

/** A turn's end that found no row of its request to record it on. */
export class NoTurn extends Data.TaggedError("NoTurn")<{
  readonly key: string
}> {}

/**
 * Records how a turn ended: the outcome, and for a failed turn the reason's tag and the whole reason (STO-76). A turn
 * whose end chad posted in the thread in place of an answer gets its line for the next turn in the same transaction.
 * A request with no row fails with `NoTurn` and writes nothing, its line included, so that an end is recorded only
 * where the volume holds it (FAIL-135).
 */
export const ended = Effect.fnUntraced(function* (end: {
  readonly key: string
  readonly outcome: "answered" | "failed" | "stopped"
  readonly failure?:
    { readonly tag: string; readonly detail: string } | undefined
  readonly at: number
  /** The session and the turn, when the model is to be told how the turn ended. */
  readonly tell?:
    { readonly session: string; readonly turn: string } | undefined
}) {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{ turn_id: string }>`
        UPDATE turns SET ended_at = ${end.at}, outcome = ${end.outcome}, failure = ${end.failure?.tag ?? null},
          failure_detail = ${end.failure?.detail ?? null}
        WHERE request_key = ${end.key}
        RETURNING turn_id
      `
      if (rows.length === 0) return yield* new NoTurn({ key: end.key })
      if (end.tell !== undefined) {
        yield* insertLine(end.tell.session, {
          turn: end.tell.turn,
          outcome: end.outcome,
          failure: end.failure?.tag,
        })
      }
    }),
  )
})

/**
 * Records a stored request that no longer decodes as a failed turn, with no start counted (SES-152, SES-205). A
 * request that never started gets a row of the thread's current session with a fresh turn id, and one that a restart
 * cut keeps the id and session of its row. The model is told of it with the next turn. Gives the turn id and the
 * session, or nothing when the row has an outcome already.
 */
export const undecodable = Effect.fnUntraced(function* (row: {
  readonly key: string
  readonly turn: string
  readonly session: string | undefined
  readonly detail: string
  readonly at: number
}) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        turn_id: string
        session_id: string | null
        status_message_id: string | null
      }>`
        INSERT INTO turns (request_key, turn_id, session_id, origin, started_at, ended_at, outcome, failure, failure_detail)
        VALUES (${row.key}, ${row.turn}, ${row.session ?? null}, 'message', ${row.at}, ${row.at}, 'failed', 'Internal',
          ${row.detail})
        ON CONFLICT (request_key) DO UPDATE SET
          ended_at = excluded.ended_at, outcome = 'failed', failure = 'Internal', failure_detail = excluded.failure_detail
        WHERE turns.outcome IS NULL
        RETURNING turn_id, session_id, status_message_id
      `
      const ended = rows[0]
      if (ended === undefined) return undefined
      const session = ended.session_id ?? undefined
      if (session !== undefined) {
        yield* insertLine(session, {
          turn: ended.turn_id,
          outcome: "failed",
          failure: "Internal",
        })
      }
      // The status message a cut start of the turn left behind (DIS-95).
      return {
        turn: ended.turn_id,
        session,
        status: ended.status_message_id ?? undefined,
      }
    }),
  )
})

/** What "Recent" in `chad status` reads from the `turns` table (FAIL-114). */
export interface Recent {
  /** The failed turns since `since`, as a count for each reason. */
  readonly failed: ReadonlyArray<{
    readonly reason: string
    readonly count: number
  }>
  /** The last five failed turns, latest first. */
  readonly last: ReadonlyArray<{
    readonly turn: string
    readonly reason: string
    readonly at: number
  }>
  /** The tokens in and out of the turns that started since each time. */
  readonly today: number
  readonly week: number
}

export const recent = Effect.fnUntraced(function* (times: {
  readonly since: number
  readonly today: number
  readonly week: number
}) {
  const sql = yield* SqlClient.SqlClient
  const failed = yield* sql<{ reason: string; count: number }>`
    SELECT COALESCE(failure, 'Internal') AS reason, COUNT(*) AS count FROM turns
    WHERE outcome = 'failed' AND ended_at >= ${times.since}
    GROUP BY reason ORDER BY count DESC, reason
  `
  const last = yield* sql<{ turn: string; reason: string; at: number }>`
    SELECT turn_id AS turn, COALESCE(failure, 'Internal') AS reason, ended_at AS at FROM turns
    WHERE outcome = 'failed' AND turn_id IS NOT NULL
    ORDER BY ended_at DESC LIMIT 5
  `
  const tokens = yield* sql<{ today: number | null; week: number | null }>`
    SELECT
      SUM(CASE WHEN started_at >= ${times.today} THEN input_tokens + output_tokens ELSE 0 END) AS today,
      SUM(input_tokens + output_tokens) AS week
    FROM turns WHERE started_at >= ${times.week}
  `
  return {
    failed,
    last,
    today: tokens[0]?.today ?? 0,
    week: tokens[0]?.week ?? 0,
  } satisfies Recent
})
