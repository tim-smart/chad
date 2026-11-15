import * as Agent from "clanka/Agent"
import type * as AgentOutput from "clanka/AgentOutput"
import { type Cause, Context, Effect } from "effect"
import * as Messages from "../Messages.ts"
import * as Logger from "./Logger.ts"
import * as Sessions from "./Sessions.ts"
import type { Lines } from "./StatusMessage.ts"

/**
 * What a turn writes to the log: its start, its steps and its end (FAIL-11, FAIL-12). The steps are read from the
 * Agent's output, which is also what the status message is made from, so a step's status line and its log line are
 * written by the one function here. A script's own lines are the exception: they are written where the executor runs
 * the script, which also sees a background sub-agent's scripts (FAIL-241).
 */

/** The ids every line of a turn carries. */
export interface Ids {
  readonly session: string
  readonly turn: string
}

/** The most of a script's source a line carries (FAIL-13). */
export const sourceChars = 2000
/** How much of the start and of the end of a script's output a line carries (FAIL-14). */
export const outputChars = 1000

/** A script's source as it is logged, cut at `sourceChars`. */
export const source = (text: string) => text.slice(0, sourceChars)

/** A script's output as it is logged: its start and its end, with the cut between them marked. */
export const output = (text: string) =>
  text.length <= outputChars * 2
    ? text
    : `${text.slice(0, outputChars)}\n[... ${text.length - outputChars * 2} characters cut ...]\n${text.slice(-outputChars)}`

/** The start of a sub-agent's prompt, as its line carries it. */
const promptChars = 200

/** What one turn's steps have seen so far, per agent. The root agent is `undefined`, and a sub-agent is its id. */
export interface Steps {
  readonly subagents: Map<number, number>
  readonly retries: Map<number | undefined, number>
}

export const steps = (): Steps => ({
  subagents: new Map(),
  retries: new Map(),
})

const subagentOf = (agent: number | undefined) =>
  agent === undefined ? {} : { subagent: agent }

/**
 * One part of the Agent's output. A part that is a step of the turn gets its log line here (FAIL-245 to FAIL-250), and
 * a part of a sub-agent carries the sub-agent's id (FAIL-241). A step that the status message shows gets its status line
 * here too, from the same call (FAIL-11, DIS-81). A script's own lines are not read from here: see `scriptStarted`.
 */
export const step = Effect.fnUntraced(function* (
  state: Steps,
  ids: Ids,
  part: AgentOutput.Output,
  status: Lines,
  /** Whether a login with a code is pending for the session, which hides the retry line (DIS-29, MOD-50). */
  loginPending: () => boolean = () => false,
) {
  const agent = part._tag === "SubagentPart" ? part.id : undefined
  const inner = part._tag === "SubagentPart" ? part.part : part
  const now = Date.now()
  switch (inner._tag) {
    case "SubagentStart": {
      state.subagents.set(inner.id, now)
      yield* status.add(Messages.statusSubagent(inner.prompt))
      return yield* Logger.event(
        "turn.subagent-started",
        "A sub-agent started",
        {
          ...ids,
          subagent: inner.id,
          prompt: inner.prompt.slice(0, promptChars),
          background: inner.background,
        },
      )
    }
    case "SubagentComplete": {
      // A sub-agent's end gets its line for the same reason as a script's (FAIL-193).
      const at = state.subagents.get(inner.id)
      state.subagents.delete(inner.id)
      return yield* Logger.event("turn.subagent-ended", "A sub-agent ended", {
        ...ids,
        subagent: inner.id,
        status: inner.status,
        duration_ms: at === undefined ? 0 : now - at,
      })
    }
    case "CompactionEnded": {
      return yield* compaction(status, {
        ...ids,
        ...subagentOf(agent),
        reason: inner.reason,
        tokens_before: inner.tokensBefore,
        tokens_after: inner.tokensAfter,
      })
    }
    case "Usage": {
      // A retry is counted per agent, since that agent's last usage.
      state.retries.set(agent, 0)
      return
    }
    case "ErrorRetry": {
      const retry = (state.retries.get(agent) ?? 0) + 1
      state.retries.set(agent, retry)
      const of = yield* Agent.MaxRetries
      // The line shows the highest count of every agent of the turn (DIS-28, FAIL-80, FAIL-81).
      if (!loginPending()) {
        yield* status.add(
          Messages.statusRetry(
            inner.error.reason._tag,
            Math.max(...state.retries.values()),
            of,
          ),
        )
      }
      return yield* Logger.event("turn.retry", "Model error, retrying", {
        ...ids,
        ...subagentOf(agent),
        reason: inner.error.reason._tag,
        error: inner.error.message,
        retry,
        of,
      })
    }
  }
})

/** A compaction's status line and its log line, from the one call for every agent (DIS-27, DIS-81, FAIL-11). */
const compaction = (status: Lines, fields: Readonly<Record<string, unknown>>) =>
  Effect.andThen(
    status.add(Messages.statusCompaction()),
    Logger.event("turn.compaction", "The history was compacted", fields),
  )

/**
 * The end lines of the sub-agents whose end the Agent's output did not carry, because the turn was stopped or failed
 * while they ran and their `SubagentComplete` was never read (FAIL-193, FAIL-248). Each start gets one end.
 */
export const unended = (state: Steps, ids: Ids) =>
  Effect.suspend(() => {
    const now = Date.now()
    const open = [...state.subagents]
    state.subagents.clear()
    return Effect.forEach(
      open,
      ([subagent, at]) =>
        Logger.event("turn.subagent-ended", "A sub-agent ended", {
          ...ids,
          subagent,
          status: "cancelled",
          duration_ms: now - at,
        }),
      { discard: true },
    )
  })

/**
 * The agent a fiber runs for, as chad marks it where a sub-agent starts. `hidden` is whether the Agent's output leaves
 * out the agent's steps, as it does for a background sub-agent and every agent under one (clanka's `Agent.ts:552,602`).
 */
export interface Marked {
  readonly id: number
  readonly hidden: boolean
}

/**
 * One key per depth. clanka runs a sub-agent with the context of the agent that started it (`Agent.ts:618-622`), which
 * replaces a key the sub-agent's fiber had under the same name, so a sub-agent's mark is kept under a key of its own
 * depth, and the deepest one set is the agent's.
 */
const marks: Array<Context.Reference<Marked | undefined>> = []
const markAt = (depth: number) =>
  (marks[depth] ??= Context.Reference<Marked | undefined>(
    `chad/TurnLog/Agent/${depth}`,
    { defaultValue: () => undefined },
  ))

/** The marks of the current fiber, the root agent's first. The root agent has none. */
export const chain = Effect.map(
  Effect.context<never>(),
  (context): ReadonlyArray<Marked> => {
    const found: Array<Marked> = []
    for (let depth = 1; depth < marks.length; depth++) {
      const mark = Context.get(context, markAt(depth))
      if (mark === undefined) break
      found.push(mark)
    }
    return found
  },
)

/** Runs `effect` with the mark of a sub-agent that the agent with `parent` as its marks starts in it. */
export const mark =
  (parent: ReadonlyArray<Marked>, marked: Marked) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, markAt(parent.length + 1), marked)

/** The mark of the agent the current fiber runs for, when it is a sub-agent whose steps the Agent's output leaves out. */
const hidden = Effect.map(chain, (found) => {
  const last = found.at(-1)
  return last?.hidden === true ? last : undefined
})

/**
 * The compaction line of an agent whose `CompactionEnded` the Agent's output leaves out (FAIL-249). clanka renders the
 * environment with `reset` right before it puts a compacted history in place, and for nothing else
 * (`Agent.ts:876-879,1025-1030`, `AgentExecutor.ts:90-93`). clanka keeps the reason and the token counts to itself
 * for such an agent, so the line has neither. Its status line is added with it, as every compaction's is (DIS-27). The
 * other agents' compactions are logged by `step`.
 */
export const compacted = (
  ids: Logger.SessionLogIds,
  reset: boolean,
  status: Lines,
) =>
  Effect.gen(function* () {
    if (!reset) return
    const agent = yield* hidden
    if (agent === undefined) return
    yield* compaction(status, scriptIds(ids, agent.id)).pipe(Logger.ownConsole)
  })

/**
 * The ids of a script's lines. chad logs a script where the executor runs it, which sees every agent's scripts, as the
 * Agent's output does not show a background sub-agent's (FAIL-241).
 */
const scriptIds = (ids: Logger.SessionLogIds, agent: number | undefined) => ({
  session: ids.session,
  ...(ids.turn === undefined ? {} : { turn: ids.turn }),
  ...subagentOf(agent),
})

/**
 * A script starts to run (FAIL-13), with its line in the status message (DIS-24, FAIL-11). The source is the whole
 * script, which is what clanka's `ScriptDelta` carries too (DIS-25). `status` is `none` for an agent whose steps the
 * Agent's output leaves out.
 */
export const scriptStarted = (
  ids: Logger.SessionLogIds,
  agent: number | undefined,
  script: string,
  status: Lines,
) =>
  Effect.andThen(
    Effect.flatMap(hidden, (agent) =>
      agent === undefined
        ? status.add(Messages.statusScript(script))
        : Effect.void,
    ),
    Logger.event("turn.script-started", "A script started", {
      ...scriptIds(ids, agent),
      source: source(script),
      source_chars: script.length,
    }).pipe(Logger.ownConsole),
  )

/** A script ended, whether or not the status message has a line for it (FAIL-14, FAIL-192). */
export const scriptEnded = (
  ids: Logger.SessionLogIds,
  agent: number | undefined,
  text: string,
  duration: number,
) =>
  Logger.event("turn.script-ended", "A script ended", {
    ...scriptIds(ids, agent),
    output: output(text),
    output_chars: text.length,
    duration_ms: duration,
  }).pipe(Logger.ownConsole)

/** Where a turn came from. Only an owner's message starts one so far. */
export type Origin = "message"

/** The first start of a turn (FAIL-244, FAIL-326). */
export const started = (ids: Ids, origin: Origin) =>
  Logger.event("turn.started", "A turn started", { ...ids, origin })

/** A later start of a turn, after a restart (FAIL-253, FAIL-326), with its line in the status message (DIS-32). */
export const resumed = (
  ids: Ids,
  origin: Origin,
  starts: number,
  status: Lines,
) =>
  Effect.andThen(
    status.add(Messages.statusRestarted()),
    Logger.event("turn.resumed", "A turn was resumed", {
      ...ids,
      origin,
      starts,
    }),
  )

/** What every end of a turn carries (FAIL-254, FAIL-255). `session` is missing when the turn ended before it had one. */
export interface End {
  readonly session?: string | undefined
  readonly turn: string
  readonly duration: number
  readonly usage: Sessions.Usage
  /** The number of messages the reconcile at the end wrote. */
  readonly reconciled: number
}

const endFields = (end: End) => ({
  ...(end.session === undefined ? {} : { session: end.session }),
  turn: end.turn,
  duration_ms: end.duration,
  ...Sessions.fields(end.usage),
  reconciled: end.reconciled,
})

/** A turn that ended as answered or stopped (FAIL-254). */
export const ended = (end: End, outcome: "answered" | "stopped") =>
  Logger.event("turn.ended", "The turn ended", {
    ...endFields(end),
    outcome,
  })

/**
 * A turn that ended as failed, at Error with the full cause (FAIL-16, FAIL-255). `fields` is what one reason adds,
 * such as the reset time of a usage limit. A turn that chad gave up on has no cause.
 */
export const failed = (
  end: End,
  reason: string,
  cause?: Cause.Cause<unknown>,
  fields: Readonly<Record<string, unknown>> = {},
) =>
  Logger.event(
    "turn.failed",
    "The turn failed",
    { ...endFields(end), reason, ...fields },
    cause,
  )
