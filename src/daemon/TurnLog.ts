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
 * What a turn writes to the log: its start, its steps and its end. The steps are read from the Agent's output, which
 * is also what the status message is made from, so a step's status line and its log line are written by the one
 * function here. A script's own lines are the exception: they are written where the executor runs the script, which
 * also sees a background sub-agent's scripts.
 */

/** The ids every line of a turn carries. */
export interface Ids {
  readonly session: string
  readonly turn: string
}

/** The most of a script's source a line carries. */
export const sourceChars = 2000
/** How much of the start and of the end of a script's output a line carries. */
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
  /**
   * The `ErrorRetry` parts of the turn so far, which the retry's status line and log line show. They are the turn's and
   * not an agent's: a part clanka held back while another agent's output ran comes as that other agent's, its `Usage`
   * too, so the Agent's output cannot say whose a retry is.
   */
  retries: number
  /**
   * The turn timeouts in a row on the agent's current model call, which the silence bound counts. They are
   * counted where the agent's model is called (`watched`), so the agent is the one that made the call.
   */
  readonly timeouts: Map<number | undefined, number>
  /** Whether chad ended the turn at a model call (`watched`). The turn then shows and logs no more retries. */
  ended: boolean
}

export const steps = (): Steps => ({
  subagents: new Map(),
  retries: 0,
  timeouts: new Map(),
  ended: false,
})

/**
 * The turn timeouts in a row after which chad ends the turn: 15 minutes of a provider saying nothing at clanka's
 * default turn timeout.
 */
export const silenceBound = 3

/**
 * The turn waits on a login: the count toward the silence bound starts again from zero, because the login's own
 * timeout is what ends that wait.
 */
export const loginWaited = (state: Steps) => state.timeouts.clear()

/**
 * chad's own end of the turn at a retry of a model call, for what clanka would keep retrying: a usage limit, a plan that
 * does not include the usage, and the third turn timeout in a row on one model call. A timeout that cut the call while
 * a login was pending for the session does not count. `retry` is the number of the retry on the call.
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
  // `TurnTimeout` is chad's own reason, with clanka's text as it arrived.
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
 * One part of the Agent's output. A part that is a step of the turn gets its log line here, and a part of a sub-agent
 * carries the sub-agent's id, apart from a retry, whose lines name no agent. A step that the status message shows gets
 * its status line here too, from the same call. A script's own lines are not read from here: see `scriptStarted`.
 */
export const step = Effect.fnUntraced(function* (
  state: Steps,
  ids: Ids,
  part: AgentOutput.Output,
  status: Lines,
  /** Whether a login with a code is pending for the session, which hides the retry line. */
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
      // A sub-agent's end gets its line for the same reason as a script's.
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
    case "ErrorRetry": {
      // chad's own ends are made where the model is called, which sees the agent that made the call and the login at
      // each attempt (`watched`). Here a retry is only shown and logged, and a turn chad ended gets no more of them, so
      // the one event of a usage limit is `turn.failed`.
      if (state.ended) return
      // The count is the turn's, and the lines name no agent, because the part may be another agent's.
      const retry = ++state.retries
      if (!loginPending()) {
        yield* status.add(Messages.statusRetry(inner.error.reason._tag, retry))
      }
      return yield* Logger.event("turn.retry", "Model error, retrying", {
        ...ids,
        reason: inner.error.reason._tag,
        error: inner.error.message,
        retry,
      })
    }
  }
})

/** A compaction's status line and its log line, from the one call for every agent. */
const compaction = (status: Lines, fields: Readonly<Record<string, unknown>>) =>
  Effect.andThen(
    status.add(Messages.statusCompaction()),
    Logger.event("turn.compaction", "The history was compacted", fields),
  )

/**
 * The end lines of the sub-agents whose end the Agent's output did not carry, because the turn was stopped or failed
 * while they ran and their `SubagentComplete` was never read. Each start gets one end.
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
 * The turn that runs now, as the model calls of its agents see it: its steps, whether a login is pending for its
 * session, and chad's own end of it.
 */
export interface Owner {
  readonly steps: Steps
  readonly loginPending: () => boolean
  /** What a model call of the turn that succeeds does, see `succeeding`. */
  readonly succeeded: Effect.Effect<void>
  /** Ends the turn with `Failed.Ended`. */
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
 * A model of the turn's agents, watched for chad's own ends of the turn: a usage limit, a plan that does not include the
 * usage, and the third turn timeout in a row on one model call. They are counted here, at
 * each attempt of the agent that makes it, for every agent. The Agent's output is no place to count them: it leaves out
 * the parts of a background sub-agent and of every agent under one, and while one shown agent's output runs it holds
 * back another's parts and later gives them as the first agent's (clanka's `Agent.ts:432-470,577-608`). Nothing is
 * logged here and no status line is added: `step` shows and logs a shown agent's retries.
 */
export const watched = <E, R>(
  layer: Layer.Layer<Provided, E, R>,
): Layer.Layer<Provided, E, R> => wrapped(layer, watch)

/**
 * A model whose calls that succeed run the turn's `succeeded`, which clears the conditions a model call or the check
 * at start began. A call has succeeded when its stream gives the `finish` part, unless the call
 * failed: the finish reason is `error`, or an `error` part came before it, which is how the decoder gives a
 * `response.failed` and which clanka retries. That holds for every agent of the turn, a hidden one too, and for a
 * provider that reports no usage, which gives no `Usage` part.
 */
export const succeeding = <E, R>(
  layer: Layer.Layer<Provided, E, R>,
): Layer.Layer<Provided, E, R> =>
  wrapped(layer, (model) => {
    const streamText = (...options: Parameters<typeof model.streamText>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const owner = yield* CurrentOwner
          const stream = model.streamText(...options)
          if (owner === undefined) return stream
          let failed = false
          return stream.pipe(
            Stream.tap((part) => {
              if (part.type === "error") failed = true
              if (part.type !== "finish") return Effect.void
              return failed || part.reason === "error"
                ? Effect.void
                : owner.succeeded
            }),
          )
        }),
      )
    return {
      ...model,
      streamText:
        streamText as unknown as LanguageModel.LanguageModel["streamText"],
    }
  })

/**
 * A model layer with its `LanguageModel` replaced by `f` of it. Everything else the layer gives is kept, such as the
 * socket and the response ids of a model on clanka's WebSocket mode, which are the model's own and not its agent's.
 */
const wrapped = <E, R>(
  layer: Layer.Layer<Provided, E, R>,
  f: (model: LanguageModel.LanguageModel) => LanguageModel.LanguageModel,
): Layer.Layer<Provided, E, R> =>
  Layer.flatMap(layer, (context) =>
    Layer.succeedContext(
      Context.add(
        context,
        LanguageModel.LanguageModel,
        f(Context.get(context, LanguageModel.LanguageModel)),
      ),
    ),
  )

/** An agent's current model call in one turn, as `watch` counts its attempts. */
interface Call {
  /** The retries of the call so far. */
  retry: number
  /**
   * Whether a login was pending for the session when clanka's turn timeout cut the last attempt, or `undefined` when
   * the timeout did not cut it. The cut counts at the next attempt, which is clanka's retry of it, with the login as it
   * stood at the cut: clanka's backoff runs between the two, and a login can complete in it. It
   * counts there and not at the cut because a stop, a parent's cancel or the end of the turn after a long silence also
   * looks like a cut, and none of them has a next attempt.
   */
  cut: boolean | undefined
}

const watch = (
  model: LanguageModel.LanguageModel,
): LanguageModel.LanguageModel => {
  // The current call of each agent of a turn that uses this model. The root agent's model serves every turn of its
  // session, and a sub-agent's is built for each start of the sub-agent.
  const turns = new WeakMap<Steps, Map<number | undefined, Call>>()
  const streamText = (...options: Parameters<typeof model.streamText>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const owner = yield* CurrentOwner
        if (owner === undefined) return model.streamText(...options)
        const { steps } = owner
        const agent = (yield* chain).at(-1)?.id
        let calls = turns.get(steps)
        if (calls === undefined) {
          calls = new Map()
          turns.set(steps, calls)
        }
        let call = calls.get(agent)
        if (call === undefined) {
          call = { retry: 0, cut: undefined }
          calls.set(agent, call)
          steps.timeouts.set(agent, 0)
        }
        const now = call
        const ended = (error: AiError.AiError, login: boolean) => {
          now.retry++
          const reason = ends(steps, agent, error, now.retry, login)
          if (reason === undefined) return false
          steps.ended = true
          owner.end(reason)
          return true
        }
        if (now.cut !== undefined) {
          const login = now.cut
          now.cut = undefined
          if (ended(Failed.turnTimeout, login)) return Stream.never
        }
        const clock = yield* Clock.Clock
        const timeout = Duration.toMillis(yield* Agent.TurnTimeout)
        let last = clock.currentTimeMillisUnsafe()
        return model.streamText(...options).pipe(
          Stream.tap((part) =>
            Effect.sync(() => {
              last = clock.currentTimeMillisUnsafe()
              // A call that finished ends the count, as an agent's `Usage` part does.
              if (part.type === "finish") {
                now.retry = 0
                steps.timeouts.set(agent, 0)
              }
            }),
          ),
          Stream.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit)) return
              if (Cause.hasInterruptsOnly(exit.cause)) {
                // clanka's timer runs from the start of the call and from each part, so its cut comes after a whole
                // timeout of silence, and a cut at a steer comes right after a part.
                if (clock.currentTimeMillisUnsafe() - last >= timeout / 2) {
                  now.cut = owner.loginPending()
                }
                return
              }
              const error = Cause.findError(exit.cause)
              if (Result.isSuccess(error) && AiError.isAiError(error.success)) {
                ended(error.success, owner.loginPending())
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
 * The compaction line of an agent whose `CompactionEnded` the Agent's output leaves out. clanka renders the
 * environment with `reset` right before it puts a compacted history in place, and for nothing else
 * (`Agent.ts:876-879,1025-1030`, `AgentExecutor.ts:90-93`). clanka keeps the reason and the token counts to itself
 * for such an agent, so the line has neither. Its status line is added with it, as every compaction's is. The
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
 * Agent's output does not show a background sub-agent's.
 */
const scriptIds = (ids: Logger.SessionLogIds, agent: number | undefined) => ({
  session: ids.session,
  ...(ids.turn === undefined ? {} : { turn: ids.turn }),
  ...subagentOf(agent),
})

/**
 * A script starts to run, with its line in the status message. The source is the whole script, which is what clanka's
 * `ScriptDelta` carries too. `status` is `none` for an agent whose steps the Agent's output leaves out.
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

/** A script ended, whether or not the status message has a line for it. */
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
export type Origin = "message" | "plugin"

/** The first start of a turn. */
export const started = (ids: Ids, origin: Origin) =>
  Logger.event("turn.started", "A turn started", { ...ids, origin })

/** A later start of a turn, after a restart, with its line in the status message. */
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

/** What every end of a turn carries. `session` is missing when the turn ended before it had one. */
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

/** A turn that ended as answered or stopped. */
export const ended = (end: End, outcome: "answered" | "stopped") =>
  Logger.event("turn.ended", "The turn ended", {
    ...endFields(end),
    outcome,
  })

/**
 * A turn that ended as failed, at Error with the full cause. `fields` is what one reason adds,
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
