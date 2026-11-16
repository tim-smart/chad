import * as Agent from "clanka/Agent"
import { ErrorRetry } from "clanka/AgentOutput"
import { Context, Duration, Effect, Layer, Stream } from "effect"
import { LanguageModel, Model as AiModel } from "effect/ai"
import { expect, it } from "vitest"
import * as Failed from "../../src/daemon/Failed.ts"
import * as StatusMessage from "../../src/daemon/StatusMessage.ts"
import * as TurnLog from "../../src/daemon/TurnLog.ts"

// A hidden agent logs nothing (ruling 98c53ea), so a daemon scenario has nothing to wait on between clanka's cut of a
// call and its retry. These run the model chad wraps directly, with clanka's race against the turn timeout.

const timeout = Duration.millis(40)

/** A model whose every call says nothing, wrapped as a session's models are. */
const silent = TurnLog.watched(
  Layer.succeedContext(
    Context.make(LanguageModel.LanguageModel, {
      streamText: () => Stream.never,
    } as unknown as LanguageModel.LanguageModel).pipe(
      Context.add(AiModel.ProviderName, "fake"),
      Context.add(AiModel.ModelName, "fake"),
    ),
  ),
)

/** One attempt of a model call, which the turn timeout cuts, as clanka races each attempt with it. */
const call = Effect.gen(function* () {
  const model = yield* LanguageModel.LanguageModel
  yield* model
    .streamText({ prompt: "hello" })
    .pipe(Stream.runDrain, Effect.timeoutOption(timeout))
})

/** A turn whose login the test completes, and the ends chad made of it at a hidden agent's call. */
const turn = () => {
  const login = { pending: false }
  const ended: Array<Failed.Reason> = []
  const owner: TurnLog.Owner = {
    steps: TurnLog.steps(),
    loginPending: () => login.pending,
    succeeded: Effect.void,
    end: (reason) => {
      ended.push(reason)
    },
  }
  return { login, ended, owner }
}

const run = <A, E>(
  owner: TurnLog.Owner,
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(silent),
      Effect.provideService(TurnLog.CurrentOwner, owner),
      Effect.provideService(Agent.TurnTimeout, timeout),
    ),
  )

it("FAIL-212 MOD-102 MOD-103 a background sub-agent's call that the turn timeout cuts while a login is pending does not count toward the silence bound, also when the login completes before clanka's retry", async () => {
  const { login, ended, owner } = turn()
  await run(
    owner,
    Effect.gen(function* () {
      login.pending = true
      yield* call
      // The login completes in clanka's backoff, after the cut and before the retry.
      login.pending = false
      // Three silent calls after the login: the retry of the fourth is where the third of them counts.
      yield* call
      yield* call
      yield* call
      expect(ended).toEqual([])
      yield* call
    }).pipe(TurnLog.mark([], { id: 1, hidden: true })),
  )
  expect(ended).toMatchObject([{ _tag: "ModelError", reason: "TurnTimeout" }])
})

it("FAIL-212 MOD-102 MOD-103 a shown agent's turn timeout counts as the login stood when clanka cut the call, also when its retry part is read after the login completed", async () => {
  const { login, owner } = turn()
  const ids = { session: "session", turn: "turn" }
  const retried = TurnLog.step(
    owner.steps,
    ids,
    new ErrorRetry({ error: Failed.turnTimeout }),
    StatusMessage.none,
    () => login.pending,
  )
  let read = 0
  const error = await run(
    owner,
    Effect.gen(function* () {
      login.pending = true
      yield* call
      // The part of that cut is read after the login completed, as it is while another agent holds clanka's output.
      login.pending = false
      yield* retried
      read++
      for (;;) {
        yield* call
        yield* retried
        read++
      }
    }).pipe(Effect.flip),
  )
  // The cut during the login did not count, so the third silent call after it is the one that ends the turn.
  expect(read).toBe(3)
  expect(error).toBeInstanceOf(Failed.Ended)
  expect(error).toMatchObject({ reason: { reason: "TurnTimeout" } })
})
