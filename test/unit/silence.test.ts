import * as Agent from "clanka/Agent"
import { Context, Duration, Effect, Layer, Stream } from "effect"
import { LanguageModel, Model as AiModel } from "effect/ai"
import { expect, it } from "vitest"
import * as Failed from "../../src/daemon/Failed.ts"
import * as TurnLog from "../../src/daemon/TurnLog.ts"

// chad counts a turn timeout at clanka's retry of the cut call, with the login as it stood at the cut. A daemon scenario
// has nothing to wait on between the cut and the retry: a hidden agent logs nothing (ruling 98c53ea), and a shown agent's
// retry part can be held back by clanka. These run the model chad wraps directly, with clanka's race against the turn
// timeout.

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

/** A turn whose login the test completes, and the ends chad made of it at a model call. */
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

it("FAIL-212 MOD-102 MOD-103 the root agent's call that the turn timeout cuts while a login is pending does not count toward the silence bound, also when the login completes before clanka's retry", async () => {
  const { login, ended, owner } = turn()
  await run(
    owner,
    Effect.gen(function* () {
      login.pending = true
      yield* call
      login.pending = false
      yield* call
      yield* call
      yield* call
      expect(ended).toEqual([])
      yield* call
    }),
  )
  expect(ended).toMatchObject([{ _tag: "ModelError", reason: "TurnTimeout" }])
})
