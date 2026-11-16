import * as Agent from "clanka/Agent"
import * as Compaction from "clanka/Compaction"
import {
  CodexAuth,
  STORE_TOKEN_KEY,
  type TokenData,
  toTokenStore,
} from "clanka/CodexAuth"
import {
  Context,
  type Duration,
  Effect,
  Exit,
  type FileSystem,
  Layer,
  Option,
  Result,
  Semaphore,
} from "effect"
import type { LanguageModel, Model as AiModel } from "effect/ai"
import { KeyValueStore } from "effect/persistence"
import * as Messages from "../Messages.ts"
import {
  type Endpoint,
  type Inputs,
  needsLogin,
  prepare,
  read,
  type Request,
  type Requirements,
  sessionModels,
  type Settings,
  type Spec,
  store,
  trial,
  Unchanged,
} from "../ModelSpec.ts"
import * as Logger from "./Logger.ts"
import * as Login from "./Login.ts"
import * as TurnLog from "./TurnLog.ts"
import type { Notices } from "./Notices.ts"

/**
 * The models of the daemon (docs/spec/05-model-and-login.md): the settings in force, the model layer a turn gets, a
 * change of the setting, and the check at start. What has nothing of the daemon in it is in `ModelSpec.ts`, which the
 * CLI shares.
 */

export {
  codexUrl,
  type Endpoint,
  needsLogin,
  parse,
  type Path,
  read,
  type Requirements,
  type Settings,
  type Spec,
  text,
  write,
} from "../ModelSpec.ts"
export { fallback } from "../ModelText.ts"

/** What a session's model layer gives a turn: its model, the sub-agents' model and the summarizer's. */
export type Provided =
  | LanguageModel.LanguageModel
  | AiModel.ProviderName
  | AiModel.ModelName
  | Agent.SubagentModel
  | Compaction.SummarizerModel

/**
 * The model layer of one session: the main model, the sub-agents' and the summarizer's, over the session's one client
 * (MOD-81, MOD-96). Without an override the sub-agents and the summarizer run on their own copies of the main model
 * (MOD-13). The summarizer layer is always there, so a summary still running when its turn ends keeps a working model
 * (MOD-14, SES-116). The agents' models are watched for the ends hidden calls make and for a login at a cut (FAIL-84,
 * FAIL-87, FAIL-89, FAIL-212), and a call of any of the three that succeeds clears the model's conditions (FAIL-94,
 * FAIL-235).
 */
export const session = (
  settings: Settings & { readonly main: Result.Success<Spec, unknown> },
  id: string | undefined,
  endpoint: Endpoint,
): Layer.Layer<Provided, never, Requirements> => {
  const main = settings.main.success
  return sessionModels(main, id, endpoint).over((model) =>
    Layer.mergeAll(
      TurnLog.watched(TurnLog.succeeding(model(main))),
      Agent.layerSubagentModel(
        TurnLog.watched(TurnLog.succeeding(model(settings.subagent ?? main))),
      ),
      Compaction.layerSummarizerModel(
        TurnLog.succeeding(model(settings.summarizer ?? main)),
      ),
    ),
  )
}

/** The models of the daemon: the settings in force, and what a turn and a change ask of them. */
export class Models extends Context.Service<
  Models,
  {
    /** The settings in force. */
    readonly settings: () => Settings
    /**
     * Readies a turn's model on the settings it read at its start: the token check of a provider that needs the login
     * (SES-56, MOD-99), and then the layer the session builds when it has none for this generation. A setting that
     * cannot run fails the turn with its refusal as an `Internal` defect (MOD-G27).
     */
    readonly prepare: (
      session: string,
      settings: Settings,
    ) => Effect.Effect<{
      readonly generation: number
      readonly layer: Layer.Layer<Provided>
    }>
    /**
     * `chad model` and `/model` with a change: the login when one is needed, the trial requests, the store and the
     * generation bump, one change at a time (MOD-15 to MOD-17, MOD-84, MOD-126). It gives what the command prints.
     */
    readonly change: (
      request: Request,
      login: Effect.Effect<void, Unchanged>,
    ) => Effect.Effect<string, Unchanged>
  }
>()("chad/Model/Models") {}

/** The models over the daemon's transports and its one Codex login. */
export const make = (options: {
  readonly initial: Settings
  readonly data: string
  readonly inputs: Inputs
  readonly requirements: Context.Context<Requirements | FileSystem.FileSystem>
  /** How long a trial request may take (MOD-88). */
  readonly deadline: Duration.Duration
  /** What a change that is stored clears: the failed check of a model nobody runs any more (FAIL-235). */
  readonly changed: Effect.Effect<void>
}): Models["Service"] => {
  const { data, inputs, requirements, deadline } = options
  let current = options.initial
  const auth = Context.get(requirements, CodexAuth)
  const changes = Semaphore.makeUnsafe(1)
  return {
    settings: () => current,
    prepare: (id, settings) =>
      Effect.gen(function* () {
        const { main } = settings
        if (Result.isFailure(main)) {
          return yield* Effect.die(new Error(main.failure.error))
        }
        // The WebSocket transport asks for a token as its layer is built, so the check comes before the build (MOD-33).
        if (needsLogin(main.success)) yield* Effect.orDie(auth.get)
        return {
          generation: settings.generation,
          layer: session({ ...settings, main }, id, inputs).pipe(
            Layer.provide(Layer.succeedContext(requirements)),
          ),
        }
      }),
    change: (request, login) =>
      changes.withPermit(
        Effect.gen(function* () {
          // Planned on what the change before this one stored, since only one runs at a time (MOD-126).
          const planned = yield* prepare({
            current,
            request,
            endpoint: inputs,
            deadline,
            login,
          })
          // The store and the settings in force move together: an interrupt waits for both, and a store that fails
          // part way reads the files again, so the daemon runs what the volume holds (MOD-12).
          yield* Effect.uninterruptible(
            store(data, planned).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  current = {
                    ...planned.settings,
                    generation: current.generation + 1,
                  }
                }),
              ),
              Effect.tapError(() =>
                read(data, inputs).pipe(
                  Effect.tap((stored) =>
                    Effect.sync(() => {
                      current = {
                        ...stored,
                        generation: current.generation + 1,
                      }
                    }),
                  ),
                  Effect.ignore,
                ),
              ),
            ),
          )
          yield* options.changed
          return planned.text
        }).pipe(Effect.provideContext(requirements)),
      ),
  }
}

/**
 * The check at start: one small request on each model chad will run, which is the main model and each override that
 * is set (MOD-25). A model on the Codex login is skipped when no token is stored, and when the token check fails, so
 * the check never waits on a login (MOD-93, MOD-94). A failure is logged and announced under one key, with a sentence
 * for each failed model in the order main, sub-agent, summarizer, and chad runs on (MOD-G30). A check that passes
 * clears the key (FAIL-234).
 */
export const check = Effect.fnUntraced(function* (options: {
  readonly settings: Settings
  readonly endpoint: Endpoint
  readonly requirements: Context.Context<Requirements>
  /** How long one request may take before it has failed (MOD-88). */
  readonly deadline: Duration.Duration
  readonly notices: Pick<Notices["Service"], "raise" | "clear">
}) {
  const { settings, requirements } = options
  const failures: Array<string> = []
  const failed = (spec: string, error: string) =>
    Effect.andThen(
      Logger.event(
        "model.check-failed",
        Messages.modelCheckFailed(spec, error),
        {
          model: spec,
          error,
        },
      ),
      Effect.sync(() => failures.push(Messages.modelCheckFailed(spec, error))),
    )
  if (Result.isFailure(settings.main)) {
    yield* failed(settings.main.failure.text, settings.main.failure.error)
  } else {
    const tokens = toTokenStore(
      Context.get(requirements, KeyValueStore.KeyValueStore),
    )
    const auth = Context.get(requirements, CodexAuth)
    const specs = [
      settings.main.success,
      settings.subagent,
      settings.summarizer,
    ]
    for (const spec of specs) {
      if (spec === undefined) continue
      if (needsLogin(spec)) {
        // No stored token skips the check (MOD-93). An expired one is refreshed through the shared login, on a fiber
        // that starts no device flow, and a refresh that fails skips the check too (MOD-94).
        const stored = yield* tokens
          .get(STORE_TOKEN_KEY)
          .pipe(Effect.orElseSucceed(() => Option.none<TokenData>()))
        if (Option.isNone(stored)) continue
        const token = yield* Effect.exit(
          Effect.provideService(auth.get, Login.Unattended, true),
        )
        if (Exit.isFailure(token)) continue
      }
      const ran = yield* trial(spec, options.endpoint, options.deadline).pipe(
        Effect.provideContext(requirements),
        Effect.result,
      )
      if (Result.isFailure(ran)) yield* failed(spec.text, ran.failure)
    }
  }
  yield* failures.length === 0
    ? options.notices.clear(checkKey)
    : options.notices.raise({ key: checkKey, text: failures.join("\n") })
})

/** The key of the notice of a failed check (FAIL-233). */
export const checkKey = "model-check-failed"

export { Unchanged }
