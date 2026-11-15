import { dirname } from "node:path"
import { OpenAiClient } from "@effect/ai-openai"
import type { ThoughtLevel } from "clanka/AcpSessionStore"
import * as Agent from "clanka/Agent"
import * as Codex from "clanka/Codex"
import {
  CodexAuth,
  STORE_TOKEN_KEY,
  type TokenData,
  toTokenStore,
} from "clanka/CodexAuth"
import * as Compaction from "clanka/Compaction"
import * as Copilot from "clanka/Copilot"
import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import * as ModelLayer from "clanka/ModelLayer"
import * as OpenAiCompat from "clanka/OpenAiCompat"
import * as Xai from "clanka/Xai"
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Result,
  Stream,
} from "effect"
import { LanguageModel, type Model as AiModel } from "effect/ai"
import { KeyValueStore } from "effect/persistence"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { PlatformError } from "effect/PlatformError"
import type { Socket } from "effect/socket"
import * as Messages from "../Messages.ts"
import { fallback, readLine } from "../ModelText.ts"
import * as Paths from "../Paths.ts"
import type { Environment } from "./Environment.ts"
import * as Failed from "./Failed.ts"
import * as Logger from "./Logger.ts"
import * as Login from "./Login.ts"
import type { Notices } from "./Notices.ts"

/**
 * The model setting and the model layer (docs/spec/05-model-and-login.md). The setting is one value in clanka's format,
 * `<provider>/<model>[/<effort>]`, and the provider decides the path a session's model layer takes:
 *
 * - `codex`: `openai` with no API key, over the one shared Codex login (MOD-2, MOD-26 to MOD-29);
 * - `openai`: `openai` with `CHAD_OPENAI_API_KEY`, the plain OpenAI API (MOD-3);
 * - `compat`: `openai-compat`, the endpoint and the key from the environment (MOD-4);
 * - `other`: `copilot` and `xai`, which chad does not block and does not test (MOD-7).
 *
 * Every path is composed by hand in the same shape, with one client per session (MOD-96).
 */

export { fallback } from "../ModelText.ts"

/** The URL of the Codex model endpoint. clanka hardcodes it, and a test rewrites its host (TST-38). */
export const codexUrl = "https://chatgpt.com/backend-api/codex"

export type Path = "codex" | "openai" | "compat" | "other"

/** A model setting that can run. */
export interface Spec {
  /** The setting as it was given, the effort included (MOD-117). */
  readonly text: string
  readonly provider: string
  readonly model: string
  readonly effort: ThoughtLevel | undefined
  readonly path: Path
}

/** What the environment says about the two paths that need no login. */
export type Endpoint = Pick<Environment, "openaiApiUrl" | "openaiApiKey">

/** A setting, or why it cannot run: `claude` (MOD-5), a value that does not parse, or `openai-compat` with no URL. */
export const parse = (
  text: string,
  endpoint: Endpoint,
): Result.Result<Spec, string> => {
  const parsed = ModelLayer.parseModelSpec(text)
  if (Option.isNone(parsed)) return Result.fail(Messages.modelUnparsable(text))
  const { provider, model, effort } = parsed.value
  switch (provider) {
    case "claude":
      return Result.fail(Messages.modelClaudeRefused)
    case "openai-compat":
      return endpoint.openaiApiUrl === undefined
        ? Result.fail(Messages.modelCompatNoUrl)
        : Result.succeed({ text, provider, model, effort, path: "compat" })
    case "openai":
      return Result.succeed({
        text,
        provider,
        model,
        effort,
        path: endpoint.openaiApiKey === undefined ? "codex" : "openai",
      })
    default:
      return Result.succeed({ text, provider, model, effort, path: "other" })
  }
}

/** The main setting as a turn's row records it, whether or not it can run (MOD-117). */
export const text = (settings: Settings) =>
  Result.isSuccess(settings.main)
    ? settings.main.success.text
    : settings.main.failure.text

/** Whether a setting's provider needs the Codex login. */
export const needsLogin = (spec: Spec) => spec.path === "codex"

/** The settings in force. The main one may be a setting that cannot run, which each turn then fails with (MOD-G27). */
export interface Settings {
  readonly main: Result.Result<
    Spec,
    { readonly text: string; readonly error: string }
  >
  readonly subagent: Spec | undefined
  readonly summarizer: Spec | undefined
  /**
   * Counts the changes of the settings and of the login. A session builds a new model layer when the number it built
   * with is not this one (MOD-30).
   */
  readonly generation: number
}

/**
 * Writes an override file as one line of plain text, by a temporary file and a rename, so that a crash leaves the old
 * value or the new one (MOD-12). `undefined` removes the file.
 */
export const write = Effect.fnUntraced(function* (
  path: string,
  text: string | undefined,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  if (text === undefined) return yield* fs.remove(path, { force: true })
  yield* fs.makeDirectory(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  yield* fs.writeFileString(temporary, text + "\n")
  yield* fs.rename(temporary, path)
})

/**
 * The settings as the volume and the environment give them. A stored override wins over `CHAD_MODEL` (MOD-11), and
 * `CHAD_MODEL` over the fallback. An override for sub-agents or the summarizer that cannot run, or that names another
 * provider than the main model, is left out for this run and its file is kept (MOD-81, MOD-G31).
 */
export const read = Effect.fnUntraced(function* (
  data: string,
  environment: Environment,
) {
  const stored = yield* readLine(Paths.model(data))
  const text = stored ?? environment.model ?? fallback
  const main = Result.mapError(parse(text, environment), (error) => ({
    text,
    error,
  }))
  const override = Effect.fnUntraced(function* (path: string) {
    const line = yield* readLine(path)
    if (line === undefined) return undefined
    const spec = parse(line, environment)
    const refused = Result.isFailure(spec)
      ? spec.failure
      : Result.isSuccess(main) &&
          spec.success.provider !== main.success.provider
        ? Messages.modelOverrideProvider(line, main.success.provider)
        : undefined
    if (refused === undefined && Result.isSuccess(spec)) return spec.success
    yield* Effect.logWarning(`${path} is ignored: ${refused}`)
    return undefined
  })
  return {
    main,
    subagent: yield* override(Paths.subagentModel(data)),
    summarizer: yield* override(Paths.summarizerModel(data)),
    generation: 0,
  } satisfies Settings
})

/** What a session's model layer gives a turn: its model, the sub-agents' model and the summarizer's. */
export type Provided =
  | LanguageModel.LanguageModel
  | AiModel.ProviderName
  | AiModel.ModelName
  | Agent.SubagentModel
  | Compaction.SummarizerModel

/**
 * What every model layer is built over: the daemon's two transports, the one shared Codex login, and the token store
 * and the login handler that clanka's other logins take (MOD-73, MOD-26).
 */
export type Requirements =
  | HttpClient.HttpClient
  | Socket.WebSocketConstructor
  | CodexAuth
  | KeyValueStore.KeyValueStore
  | DeviceCodeHandler

/**
 * The `HttpClient` under one session's client, which adds the session's id as the `session-id` header to every
 * request. On the WebSocket transport the request that opens the socket goes through it too, and its headers are
 * handed to the WebSocket constructor (MOD-32).
 */
const sessionHttp = (session: string | undefined) =>
  session === undefined
    ? Layer.empty
    : Layer.effect(
        HttpClient.HttpClient,
        Effect.map(
          HttpClient.HttpClient,
          HttpClient.mapRequest(
            HttpClientRequest.setHeader("session-id", session),
          ),
        ),
      )

const effortOf = (spec: Spec) =>
  spec.effort === undefined ? {} : { reasoning: { effort: spec.effort } }

/**
 * One model of a session, with a client of its own (MOD-29, MOD-96). The session's id is its `prompt_cache_key` and
 * its header on a Codex login and on `openai` with a key, and `openai-compat` gets neither (MOD-31, MOD-32, MOD-97,
 * MOD-98). A model built for no session, as the check at start is, gets clanka's own random key and no header.
 */
const languageModel = (
  spec: Spec,
  session: string | undefined,
  endpoint: Endpoint,
): Layer.Layer<
  LanguageModel.LanguageModel | AiModel.ProviderName | AiModel.ModelName,
  never,
  Requirements
> => {
  const options = { ...effortOf(spec), prompt_cache_key: session }
  switch (spec.path) {
    case "codex":
      // `layerClientNoDeps` takes the shared `CodexAuth` from context, so this client holds no login of its own
      // (MOD-27, MOD-28).
      return Codex.modelWebSocket(spec.model, options).pipe(
        Layer.provide(
          OpenAiClient.layer({ apiUrl: codexUrl }).pipe(
            Layer.provide(CodexAuth.layerClientNoDeps),
            Layer.provide(sessionHttp(session)),
          ),
        ),
      )
    case "openai":
      return Codex.model(spec.model, options).pipe(
        Layer.provide(
          OpenAiClient.layer({
            apiUrl: endpoint.openaiApiUrl,
            apiKey:
              endpoint.openaiApiKey === undefined
                ? undefined
                : Redacted.make(endpoint.openaiApiKey),
          }).pipe(Layer.provide(sessionHttp(session))),
        ),
      )
    case "compat":
      return OpenAiCompat.model(spec.model, effortOf(spec)).pipe(
        Layer.provide(
          OpenAiCompat.layerClient({
            apiUrl: endpoint.openaiApiUrl,
            apiKey:
              endpoint.openaiApiKey === undefined
                ? undefined
                : Redacted.make(endpoint.openaiApiKey),
          }),
        ),
      )
    case "other":
      // clanka's own clients, with their own logins over the token store and no key or header (MOD-7, MOD-G34).
      return spec.provider === "xai"
        ? Xai.modelWebSocket(spec.model, effortOf(spec)).pipe(
            Layer.provide(Xai.layerClient),
          )
        : Copilot.model(spec.model, effortOf(spec)).pipe(
            Layer.provide(Copilot.layerClient),
          )
  }
}

/**
 * The model layer of one session: the main model, the sub-agents' and the summarizer's. Without an override the
 * sub-agents and the summarizer run on their own copies of the main model (MOD-13). The summarizer layer is always
 * there, so a summary still running when its turn ends keeps a working client (MOD-14, SES-116).
 */
export const session = (
  settings: Settings & { readonly main: Result.Success<Spec, unknown> },
  id: string | undefined,
  endpoint: Endpoint,
): Layer.Layer<Provided, never, Requirements> => {
  const main = languageModel(settings.main.success, id, endpoint)
  const of = (spec: Spec | undefined) =>
    spec === undefined ? main : languageModel(spec, id, endpoint)
  return Layer.mergeAll(
    main,
    Agent.layerSubagentModel(of(settings.subagent)),
    Compaction.layerSummarizerModel(of(settings.summarizer)),
  )
}

/** The models of the daemon: the settings in force, and what a turn asks of them. */
export class Models extends Context.Service<
  Models,
  {
    /** The settings in force. */
    readonly settings: () => Settings
    /**
     * Readies a turn's model: the token check of a provider that needs the login (SES-56, MOD-99), and then the layer
     * the session builds when it has none for this generation. A setting that cannot run fails the turn with its
     * refusal as an `Internal` defect (MOD-G27).
     */
    readonly prepare: (session: string) => Effect.Effect<{
      readonly generation: number
      readonly layer: Layer.Layer<Provided>
    }>
  }
>()("chad/Model/Models") {}

/** The models over the daemon's transports and its one Codex login. */
export const make = (
  initial: Settings,
  endpoint: Endpoint,
  requirements: Context.Context<Requirements>,
): Models["Service"] => {
  const current = initial
  const auth = Context.get(requirements, CodexAuth)
  return {
    settings: () => current,
    prepare: (id) =>
      Effect.gen(function* () {
        const settings = current
        const { main } = settings
        if (Result.isFailure(main)) {
          return yield* Effect.die(new Error(main.failure.error))
        }
        // The WebSocket transport asks for a token as its layer is built, so the check comes before the build (MOD-33).
        if (needsLogin(main.success)) yield* Effect.orDie(auth.get)
        return {
          generation: settings.generation,
          layer: session({ ...settings, main }, id, endpoint).pipe(
            Layer.provide(Layer.succeedContext(requirements)),
          ),
        }
      }),
  }
}

/** The text of a failed check: the model error's reason and message, or the defect's message. */
const failure = (cause: Cause.Cause<unknown>) => {
  const reason = Failed.classify(cause)
  return reason._tag === "ModelError"
    ? `${reason.reason}: ${reason.message.split("\n")[0]}`
    : reason._tag === "Internal"
      ? reason.message
      : reason._tag
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
      // A stream, because the Codex endpoint answers nothing else.
      const ran = yield* LanguageModel.streamText({
        prompt: Messages.modelTrial,
      }).pipe(
        Stream.runDrain,
        Effect.timeoutOrElse({
          duration: options.deadline,
          orElse: () => Effect.die(new Error(Messages.modelTrialTimedOut)),
        }),
        Effect.provide(
          languageModel(spec, undefined, options.endpoint).pipe(
            Layer.provide(Layer.succeedContext(requirements)),
          ),
        ),
        Effect.exit,
      )
      if (Exit.isFailure(ran)) yield* failed(spec.text, failure(ran.cause))
    }
  }
  yield* failures.length === 0
    ? options.notices.clear(checkKey)
    : options.notices.raise({ key: checkKey, text: failures.join("\n") })
})

/** The key of the notice of a failed check (FAIL-233). */
export const checkKey = "model-check-failed"
