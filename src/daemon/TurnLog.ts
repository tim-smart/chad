import * as Agent from "clanka/Agent"
import type * as AgentOutput from "clanka/AgentOutput"
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Result,
  Stream,
} from "effect"
import { AiError, LanguageModel, Model as AiModel } from "effect/ai"
import * as Messages from "../Messages.ts"
import * as Failed from "./Failed.ts"
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
  /** The `ErrorRetry` parts since the agent's last `Usage`, which the status line shows (FAIL-81). */
  readonly retries: Map<number | undefined, number>
  /** The turn timeouts in a row on the agent's current model call, which the silence bound counts (FAIL-84). */
  readonly timeouts: Map<number | undefined, number>
}

export const steps = (): Steps => ({
  subagents: new Map(),
  retries: new Map(),
  timeouts: new Map(),
})

/**
 * The turn timeouts in a row after which chad ends the turn: 15 minutes of a provider saying nothing at clanka's
 * default turn timeout (FAIL-84).
 */
export const silenceBound = 3

/**
 * The turn waits on a login: the count toward the silence bound starts again from zero, because the login's own
 * timeout is what ends that wait (MOD-102, MOD-103, FAIL-212).
 */
export const loginWaited = (state: Steps) => state.timeouts.clear()

/**
 * chad's own end of the turn at an `ErrorRetry` part, for what clanka would keep retrying: a usage limit, a plan that
 * does not include the usage, and the third turn timeout in a row on one model call (SES-133, FAIL-84, FAIL-87,
 * FAIL-89). A timeout while a login is pending for the session does not count (FAIL-212).
 */
const ends = (
  state: Steps,
  agent: number | undefined,
  error: AiError.AiError,
  retry: number,
  loginPending: boolean,
): Failed.Reason | undefined => {
  const limit = Failed.usageLimit(error)
  if (limit !== undefined) return limit
  if (Failed.notIncluded(error)) {
    return {
      _tag: "ModelError",
      reason: error.reason._tag,
      message: error.reason.message,
      retries: retry - 1,
    }
  }
  if (!Failed.isTurnTimeout(error) || loginPending) {
    state.timeouts.set(agent, 0)
    return undefined
  }
  const silent = (state.timeouts.get(agent) ?? 0) + 1
  state.timeouts.set(agent, silent)
  if (silent < silenceBound) return undefined
  // `TurnTimeout` is chad's own reason, with clanka's text as it arrived (API-113, FAIL-203).
  return {
    _tag: "ModelError",
    reason: "TurnTimeout",
    message: error.reason.message,
    retries: retry,
  }
}

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
      // A retry is counted per agent, since that agent's last usage, and a call that succeeded ends the timeouts in a row.
      state.retries.set(agent, 0)
      state.timeouts.set(agent, 0)
      return
    }
    case "ErrorRetry": {
      const retry = (state.retries.get(agent) ?? 0) + 1
      state.retries.set(agent, retry)
      // A turn chad ends here gets no retry line, so its one event is `turn.failed` (FAIL-242, MOD-114).
      const reason = ends(state, agent, inner.error, retry, loginPending())
      if (reason !== undefined) return yield* new Failed.Ended({ reason })
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
 * The turn that runs now, as the model calls of a sub-agent whose steps the Agent's output leaves out see it: its
 * steps, whether a login is pending for its session, and chad's own end of it.
 */
export interface Owner {
  readonly steps: Steps
  readonly loginPending: () => boolean
  /** Ends the turn as `step` ends it at an `ErrorRetry` part, with `Failed.Ended`. */
  readonly end: (reason: Failed.Reason) => void
}

/** The turn that runs on a fiber. The session provides it where the turn's `send` starts, so every agent has it. */
export const CurrentOwner = Context.Reference<Owner | undefined>(
  "chad/TurnLog/Owner",
  { defaultValue: () => undefined },
)

type Provided =
  LanguageModel.LanguageModel | AiModel.ProviderName | AiModel.ModelName

/**
 * A sub-agent's model, watched for the ends that `step` makes at an `ErrorRetry` part: a usage limit, a plan that does
 * not include the usage, and the third turn timeout in a row on one model call (FAIL-84, FAIL-87, FAIL-89). The Agent's
 * output leaves out the parts of a background sub-agent and of every agent under one, so for such an agent the model
 * calls are where the errors are seen. Nothing is logged and no status line is added for them (ruling 98c53ea). Each
 * sub-agent builds its own copy of the layer, so the counts here are one agent's.
 */
export const watched = <E, R>(
  layer: Layer.Layer<Provided, E, R>,
): Layer.Layer<Provided, E, R> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      return Context.make(LanguageModel.LanguageModel, watch(model)).pipe(
        Context.add(AiModel.ProviderName, yield* AiModel.ProviderName),
        Context.add(AiModel.ModelName, yield* AiModel.ModelName),
      )
    }),
  ).pipe(Layer.provide(layer))

const watch = (
  model: LanguageModel.LanguageModel,
): LanguageModel.LanguageModel => {
  // The `ErrorRetry` parts of the agent's current model call, as `Steps.retries` counts a shown agent's.
  let retry = 0
  // Whether clanka's turn timeout cut the last attempt. clanka cuts an attempt that way only to retry it.
  let timedOut = false
  let first = true
  const streamText = (...options: Parameters<typeof model.streamText>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const owner = yield* CurrentOwner
        const agent = yield* hidden
        if (owner === undefined || agent === undefined) {
          return model.streamText(...options)
        }
        const { steps } = owner
        if (first) {
          first = false
          steps.timeouts.set(agent.id, 0)
        }
        const ended = (error: AiError.AiError) => {
          retry++
          const reason = ends(
            steps,
            agent.id,
            error,
            retry,
            owner.loginPending(),
          )
          if (reason !== undefined) owner.end(reason)
          return reason !== undefined
        }
        // This call is clanka's retry of the one its turn timeout cut, which is where its `ErrorRetry` part was made.
        if (timedOut) {
          timedOut = false
          if (ended(Failed.turnTimeout)) return Stream.never
        }
        const clock = yield* Clock.Clock
        const timeout = Duration.toMillis(yield* Agent.TurnTimeout)
        let last = clock.currentTimeMillisUnsafe()
        return model.streamText(...options).pipe(
          Stream.tap((part) =>
            Effect.sync(() => {
              last = clock.currentTimeMillisUnsafe()
              // A call that finished ends the count, as a shown agent's `Usage` part does.
              if (part.type === "finish") {
                retry = 0
                steps.timeouts.set(agent.id, 0)
              }
            }),
          ),
          Stream.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit)) return
              if (Cause.hasInterruptsOnly(exit.cause)) {
                // clanka's timer runs from the start of the call and from each part, so its cut comes after a whole
                // timeout of silence, and a cut at a steer comes right after a part.
                timedOut = clock.currentTimeMillisUnsafe() - last >= timeout / 2
                return
              }
              const error = Cause.findError(exit.cause)
              if (Result.isSuccess(error) && AiError.isAiError(error.success)) {
                ended(error.success)
              }
            }),
          ),
        )
      }),
    )
  return {
    ...model,
    streamText:
      streamText as unknown as LanguageModel.LanguageModel["streamText"],
  }
}

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
