import * as Agent from "clanka/Agent"
import type * as AgentOutput from "clanka/AgentOutput"
import type { Cause } from "effect"
import { Effect } from "effect"
import * as Logger from "./Logger.ts"
import * as Sessions from "./Sessions.ts"

/**
 * What a turn writes to the log: its start, its steps and its end (FAIL-11, FAIL-12). The steps are read from the
 * Agent's output, which is also what the status message is made from, so a step's status line and its log line are
 * written by the one function here.
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
  readonly scripts: Map<number | undefined, { source: string; at: number }>
  readonly subagents: Map<number, number>
  readonly retries: Map<number | undefined, number>
}

export const steps = (): Steps => ({
  scripts: new Map(),
  subagents: new Map(),
  retries: new Map(),
})

const subagentOf = (agent: number | undefined) =>
  agent === undefined ? {} : { subagent: agent }

/**
 * One part of the Agent's output. A part that is a step of the turn gets its line here (FAIL-245 to FAIL-250), and a
 * part of a sub-agent carries the sub-agent's id (FAIL-241).
 */
export const step = Effect.fnUntraced(function* (
  state: Steps,
  ids: Ids,
  part: AgentOutput.Output,
) {
  const agent = part._tag === "SubagentPart" ? part.id : undefined
  const inner = part._tag === "SubagentPart" ? part.part : part
  const now = Date.now()
  switch (inner._tag) {
    case "ScriptStart": {
      state.scripts.set(agent, { source: "", at: now })
      return
    }
    case "ScriptDelta": {
      const script = state.scripts.get(agent) ?? { source: "", at: now }
      script.source += inner.delta
      state.scripts.set(agent, script)
      return
    }
    case "ScriptEnd": {
      // The model has finished writing the script, which runs from here.
      const script = state.scripts.get(agent) ?? { source: "", at: now }
      script.at = now
      state.scripts.set(agent, script)
      return yield* Logger.event("turn.script-started", "A script started", {
        ...ids,
        ...subagentOf(agent),
        source: source(script.source),
        source_chars: script.source.length,
      })
    }
    case "ScriptOutput": {
      // A script's end gets its line whether or not the status message has one for it (FAIL-192).
      const script = state.scripts.get(agent)
      state.scripts.delete(agent)
      return yield* Logger.event("turn.script-ended", "A script ended", {
        ...ids,
        ...subagentOf(agent),
        output: output(inner.output),
        output_chars: inner.output.length,
        duration_ms: script === undefined ? 0 : now - script.at,
      })
    }
    case "SubagentStart": {
      state.subagents.set(inner.id, now)
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
      return yield* Logger.event(
        "turn.compaction",
        "The history was compacted",
        {
          ...ids,
          ...subagentOf(agent),
          reason: inner.reason,
          tokens_before: inner.tokensBefore,
          tokens_after: inner.tokensAfter,
        },
      )
    }
    case "Usage": {
      // A retry is counted per agent, since that agent's last usage.
      state.retries.set(agent, 0)
      return
    }
    case "ErrorRetry": {
      const retry = (state.retries.get(agent) ?? 0) + 1
      state.retries.set(agent, retry)
      return yield* Logger.event("turn.retry", "Model error, retrying", {
        ...ids,
        ...subagentOf(agent),
        reason: inner.error.reason._tag,
        error: inner.error.message,
        retry,
        of: yield* Agent.MaxRetries,
      })
    }
  }
})

/** Where a turn came from. Only an owner's message starts one so far. */
export type Origin = "message"

/** The first start of a turn (FAIL-244, FAIL-326). */
export const started = (ids: Ids, origin: Origin) =>
  Logger.event("turn.started", "A turn started", { ...ids, origin })

/** A later start of a turn, after a restart (FAIL-253, FAIL-326). */
export const resumed = (ids: Ids, origin: Origin, starts: number) =>
  Logger.event("turn.resumed", "A turn was resumed", { ...ids, origin, starts })

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
