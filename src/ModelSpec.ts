import { dirname } from "node:path"
import { OpenAiClient } from "@effect/ai-openai"
import type { ThoughtLevel } from "clanka/AcpSessionStore"
import * as Codex from "clanka/Codex"
import { CodexAuth } from "clanka/CodexAuth"
import * as Copilot from "clanka/Copilot"
import type { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import * as ModelLayer from "clanka/ModelLayer"
import * as OpenAiCompat from "clanka/OpenAiCompat"
import * as Xai from "clanka/Xai"
import {
  Cause,
  Data,
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
import type { KeyValueStore } from "effect/persistence"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { PlatformError } from "effect/PlatformError"
import type { Socket } from "effect/socket"
import * as Errno from "./Errno.ts"
import * as Failed from "./daemon/Failed.ts"
import * as Messages from "./Messages.ts"
import { fallback, flagValue, readLine } from "./ModelText.ts"

export { clear, flagValue } from "./ModelText.ts"
import * as Paths from "./Paths.ts"

/**
 * The model setting, the model layer and a change of the setting (docs/spec/05-model-and-login.md), with nothing of
 * the daemon in it, so that `chad model` with no daemon makes the same trial request and the same store as the daemon
 * does (MOD-22, MOD-90). The setting is one value in clanka's format, `<provider>/<model>[/<effort>]`, and the
 * provider decides the path a session's model layer takes:
 *
 * - `codex`: `openai` with no API key, over the one shared Codex login (MOD-2, MOD-26 to MOD-29);
 * - `openai`: `openai` with `CHAD_OPENAI_API_KEY`, the plain OpenAI API (MOD-3);
 * - `compat`: `openai-compat`, the endpoint and the key from the environment (MOD-4);
 * - `other`: `copilot` and `xai`, which chad does not block and does not test (MOD-7).
 *
 * Every path is composed by hand in the same shape, with one client per session (MOD-96).
 */

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
export interface Endpoint {
  readonly openaiApiUrl: string | undefined
  readonly openaiApiKey: string | undefined
}

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

/** The two overrides beside the main model (MOD-13, MOD-80). */
export type Override = "subagent" | "summarizer"

const overrides: ReadonlyArray<Override> = ["subagent", "summarizer"]

/** The file of each setting under `state/` (MOD-12, STO-143, MOD-123). */
const files = {
  main: Paths.model,
  subagent: Paths.subagentModel,
  summarizer: Paths.summarizerModel,
} as const

/** The settings in force. The main one may be a setting that cannot run, which each turn then fails with (MOD-G27). */
export interface Settings {
  readonly main: Result.Result<
    Spec,
    { readonly text: string; readonly error: string }
  >
  readonly subagent: Spec | undefined
  readonly summarizer: Spec | undefined
  /** The stored overrides this run leaves out, with why, which `chad model` shows (MOD-81, MOD-G31). */
  readonly ignored: ReadonlyArray<{
    readonly override: Override
    readonly text: string
    readonly error: string
  }>
  /**
   * Counts the changes of the settings and of the login. A session builds a new model layer when the number it built
   * with is not this one (MOD-30).
   */
  readonly generation: number
}

/**
 * Writes an override file as one line of plain text, by a temporary file that is synced and then renamed over the old
 * one, so that a kill or a crash at any point leaves the old value or the new one (MOD-12). `undefined` removes the
 * file.
 */
export const write = Effect.fnUntraced(function* (
  path: string,
  text: string | undefined,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  if (text === undefined) return yield* fs.remove(path, { force: true })
  yield* fs.makeDirectory(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temporary, { flag: "w" })
      yield* file.writeAll(new TextEncoder().encode(text + "\n"))
      yield* file.sync
    }),
  )
  yield* fs.rename(temporary, path)
})

/** What `read` takes of the environment: `CHAD_MODEL` and the endpoint. */
export interface Inputs extends Endpoint {
  readonly model: string | undefined
}

/**
 * The settings as the volume and the environment give them. A stored override wins over `CHAD_MODEL` (MOD-11), and
 * `CHAD_MODEL` over the fallback. An override for sub-agents or the summarizer that cannot run, or that names another
 * provider than the main model, is left out for this run and its file is kept (MOD-81, MOD-G31).
 */
export const read = Effect.fnUntraced(function* (data: string, inputs: Inputs) {
  const stored = yield* readLine(Paths.model(data))
  const text = stored ?? inputs.model ?? fallback
  const main = Result.mapError(parse(text, inputs), (error) => ({
    text,
    error,
  }))
  const ignored: Array<Settings["ignored"][number]> = []
  const override = Effect.fnUntraced(function* (which: Override) {
    const path = files[which](data)
    const line = yield* readLine(path)
    if (line === undefined) return undefined
    const refused = checkOverride(line, main, inputs)
    if (Result.isSuccess(refused)) return refused.success
    yield* Effect.logWarning(`${path} is ignored: ${refused.failure}`)
    ignored.push({ override: which, text: line, error: refused.failure })
    return undefined
  })
  return {
    main,
    subagent: yield* override("subagent"),
    summarizer: yield* override("summarizer"),
    ignored,
    generation: 0,
  } satisfies Settings
})

/** An override, or why it cannot run beside the main model: it does not parse, or names another provider (MOD-81). */
const checkOverride = (
  line: string,
  main: Settings["main"],
  endpoint: Endpoint,
): Result.Result<Spec, string> =>
  Result.flatMap(parse(line, endpoint), (spec) =>
    Result.isSuccess(main) && spec.provider !== main.success.provider
      ? Result.fail(Messages.modelOverrideProvider(line, main.success.provider))
      : Result.succeed(spec),
  )

/**
 * What every model layer is built over: the two transports, the one shared Codex login, and the token store and the
 * login handler that clanka's other logins take (MOD-73, MOD-26).
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

/** The models a session's layer gives. */
type Provided =
  LanguageModel.LanguageModel | AiModel.ProviderName | AiModel.ModelName

/**
 * The models of one session over the session's one client (MOD-29, MOD-81, MOD-96). `over` builds the layers that
 * `build` makes from `model` with the client provided once under them, so a layer that clanka builds afresh for each
 * sub-agent and each summary rebuilds the model and not the client. An override names the main model's provider
 * (MOD-81), so it runs on the same client.
 */
export interface Models {
  readonly over: <A, E>(
    build: <C>(
      model: (spec: Spec) => Layer.Layer<Provided, never, C | Requirements>,
    ) => Layer.Layer<A, E, C | Requirements>,
  ) => Layer.Layer<A, E, Requirements>
}

const models = <C>(
  client: Layer.Layer<C, never, Requirements>,
  model: (spec: Spec) => Layer.Layer<Provided, never, C | Requirements>,
): Models => ({
  over: (build) => build(model).pipe(Layer.provide(client)),
})

/**
 * The client of a session on `main`'s path, and its models. The session's id is its `prompt_cache_key` and its header
 * on a Codex login and on `openai` with a key, and `openai-compat` gets neither (MOD-31, MOD-32, MOD-97, MOD-98). A
 * model built for no session, as a check or a trial is, gets clanka's own random key and no header.
 */
export const sessionModels = (
  main: Spec,
  session: string | undefined,
  endpoint: Endpoint,
): Models => {
  const options = (spec: Spec) => ({
    ...effortOf(spec),
    prompt_cache_key: session,
  })
  const apiKey =
    endpoint.openaiApiKey === undefined
      ? undefined
      : Redacted.make(endpoint.openaiApiKey)
  switch (main.path) {
    case "codex":
      // `layerClientNoDeps` takes the shared `CodexAuth` from context, so this client holds no login of its own
      // (MOD-27, MOD-28).
      return models(
        OpenAiClient.layer({ apiUrl: codexUrl }).pipe(
          Layer.provide(CodexAuth.layerClientNoDeps),
          Layer.provide(sessionHttp(session)),
        ),
        (spec) => Codex.modelWebSocket(spec.model, options(spec)),
      )
    case "openai":
      return models(
        OpenAiClient.layer({ apiUrl: endpoint.openaiApiUrl, apiKey }).pipe(
          Layer.provide(sessionHttp(session)),
        ),
        (spec) => Codex.model(spec.model, options(spec)),
      )
    case "compat":
      return models(
        OpenAiCompat.layerClient({ apiUrl: endpoint.openaiApiUrl, apiKey }),
        (spec) => OpenAiCompat.model(spec.model, effortOf(spec)),
      )
    case "other":
      // clanka's own clients, with their own logins over the token store and no key or header (MOD-7, MOD-G34).
      return main.provider === "xai"
        ? models(Xai.layerClient, (spec) =>
            Xai.modelWebSocket(spec.model, effortOf(spec)),
          )
        : models(Copilot.layerClient, (spec) =>
            Copilot.model(spec.model, effortOf(spec)),
          )
  }
}

/** One model with a client of its own, as a check or a trial runs it. */
export const languageModel = (
  spec: Spec,
  session: string | undefined,
  endpoint: Endpoint,
): Layer.Layer<Provided, never, Requirements> =>
  sessionModels(spec, session, endpoint).over((model) => model(spec))

/** The text of a failed check or trial: the model error's reason and message, or the defect's message. */
const failure = (cause: Cause.Cause<unknown>) => {
  const reason = Failed.classify(cause)
  return reason._tag === "ModelError"
    ? `${reason.reason}: ${reason.message.split("\n")[0]}`
    : reason._tag === "Internal"
      ? reason.message
      : reason._tag
}

/**
 * One small request on a model, the fixed prompt through the model layer a turn would use, with no output limit and
 * no retry (MOD-25, MOD-86, MOD-89). A model that has not answered by the deadline has failed (MOD-88). It fails with
 * the text of what went wrong, and an interrupt stays an interrupt.
 */
export const trial = (
  spec: Spec,
  endpoint: Endpoint,
  deadline: Duration.Duration,
): Effect.Effect<void, string, Requirements> =>
  Effect.gen(function* () {
    // A stream, because the Codex endpoint answers nothing else.
    const ran = yield* LanguageModel.streamText({
      prompt: Messages.modelTrial,
    }).pipe(
      Stream.runDrain,
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () => Effect.die(new Error(Messages.modelTrialTimedOut)),
      }),
      Effect.provide(languageModel(spec, undefined, endpoint)),
      Effect.exit,
    )
    if (Exit.isSuccess(ran)) return
    if (Cause.hasInterruptsOnly(ran.cause)) return yield* Effect.interrupt
    return yield* Effect.fail(failure(ran.cause))
  })

/**
 * A change that `chad model` and `/model` ask for (MOD-15, MOD-82, MOD-83). A missing field is left as it is, and
 * `null` clears an override.
 */
export interface Request {
  readonly main?: string | undefined
  readonly subagent?: string | null | undefined
  readonly summarizer?: string | null | undefined
}

/** Whether a request changes nothing, which is `chad model` and `/model` with no argument (MOD-19). */
export const isShow = (request: Request) =>
  request.main === undefined &&
  request.subagent === undefined &&
  request.summarizer === undefined

/**
 * The words after `/model`: an optional setting and the two flags, each with its value (MOD-82, MOD-123). It fails
 * with the usage line for anything else.
 */
export const parseWords = (
  words: ReadonlyArray<string>,
): Result.Result<Request, string> => {
  const request: { -readonly [K in keyof Request]: Request[K] } = {}
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!
    const flag = word === "--subagent" || word === "--summarizer"
    if (flag) {
      const value = words[++at]
      const which = word === "--subagent" ? "subagent" : "summarizer"
      if (value === undefined || request[which] !== undefined) {
        return Result.fail(Messages.modelUsage)
      }
      request[which] = flagValue(value)
    } else if (word.startsWith("-") || request.main !== undefined) {
      return Result.fail(Messages.modelUsage)
    } else {
      request.main = word
    }
  }
  return Result.succeed(request)
}

/** Why a change stored nothing, as the text `chad model` and `/model` print (MOD-16, MOD-84, MOD-124). */
export class Unchanged extends Data.TaggedError("ModelUnchanged")<{
  readonly text: string
}> {}

/** A change that passed its checks: what it stores, the settings it leaves in force, and what the command prints. */
export interface Plan {
  readonly settings: Settings
  /** The models to try before anything is stored: the new main model and each override set (MOD-84, MOD-87). */
  readonly trials: ReadonlyArray<Spec>
  readonly writes: ReadonlyArray<
    readonly [keyof typeof files, string | undefined]
  >
  readonly text: string
}

/**
 * Plans a change on the settings in force. The new main model and each override set must be able to run, and an
 * override must name the main model's provider (MOD-81). A main model on another provider clears every override this
 * request does not set, and the text says so (MOD-85). The generation is the caller's to move.
 */
export const plan = (
  current: Settings,
  request: Request,
  endpoint: Endpoint,
): Result.Result<Plan, Unchanged> => {
  const refused = (reason: string) =>
    Result.fail(new Unchanged({ text: Messages.modelRefused(reason) }))
  let main: Spec
  if (request.main !== undefined) {
    const parsed = parse(request.main, endpoint)
    if (Result.isFailure(parsed)) return refused(parsed.failure)
    main = parsed.success
  } else if (Result.isSuccess(current.main)) {
    main = current.main.success
  } else {
    return refused(current.main.failure.error)
  }
  const before = Result.isSuccess(current.main)
    ? current.main.success.provider
    : undefined
  const moved = request.main !== undefined && before !== main.provider
  const trials: Array<Spec> = request.main === undefined ? [] : [main]
  const writes: Array<readonly [keyof typeof files, string | undefined]> =
    request.main === undefined ? [] : [["main", main.text]]
  const lines: Array<string> =
    request.main === undefined ? [] : [Messages.modelNow(main.text)]
  const kept: { -readonly [K in Override]: Spec | undefined } = {
    subagent: current.subagent,
    summarizer: current.summarizer,
  }
  const cleared: Array<Override> = []
  for (const which of overrides) {
    const asked = request[which]
    if (asked === undefined) {
      const stored =
        current[which] !== undefined ||
        current.ignored.some((ignored) => ignored.override === which)
      if (moved && stored) {
        kept[which] = undefined
        cleared.push(which)
        writes.push([which, undefined])
      }
      continue
    }
    if (asked === null) {
      kept[which] = undefined
      writes.push([which, undefined])
      lines.push(Messages.modelOverrideNow(which, undefined))
      continue
    }
    const spec = checkOverride(asked, Result.succeed(main), endpoint)
    if (Result.isFailure(spec)) return refused(spec.failure)
    kept[which] = spec.success
    trials.push(spec.success)
    writes.push([which, spec.success.text])
    lines.push(Messages.modelOverrideNow(which, spec.success.text))
  }
  if (cleared.length > 0 && before !== undefined) {
    lines.push(Messages.modelOverridesCleared(cleared, before))
  }
  return Result.succeed({
    settings: {
      main: Result.succeed(main),
      ...kept,
      ignored: current.ignored.filter((ignored) =>
        writes.every(([which]) => which !== ignored.override),
      ),
      generation: current.generation,
    },
    trials,
    writes,
    text: lines.join("\n"),
  })
}

/**
 * Readies a change: the plan, then the login when a model to try needs one and none exists (MOD-17), then the trial
 * request of each model to try, one after another (MOD-16, MOD-84). The first that fails ends the change with nothing
 * stored.
 */
export const prepare = Effect.fnUntraced(function* <E>(options: {
  readonly current: Settings
  readonly request: Request
  readonly endpoint: Endpoint
  readonly deadline: Duration.Duration
  /** Runs the login, or fails with what the command prints. */
  readonly login: Effect.Effect<void, E, Requirements>
}): Effect.fn.Return<Plan, Unchanged | E, Requirements> {
  const planned = plan(options.current, options.request, options.endpoint)
  if (Result.isFailure(planned)) return yield* planned.failure
  const { trials } = planned.success
  if (trials.some(needsLogin)) yield* options.login
  for (const spec of trials) {
    yield* trial(spec, options.endpoint, options.deadline).pipe(
      Effect.mapError(
        (error) =>
          new Unchanged({
            text: Messages.modelTrialFailed(spec.text, error),
          }),
      ),
    )
  }
  return planned.success
})

/**
 * Stores a plan, one file after another, each by temp file and rename (MOD-12). The main model goes first: a kill
 * between two files leaves an override of the old provider, which the next read leaves out (MOD-G31).
 */
export const store = Effect.fnUntraced(function* (data: string, planned: Plan) {
  for (const [which, text] of planned.writes) {
    const path = files[which](data)
    yield* write(path, text).pipe(
      Effect.mapError(
        (error) =>
          new Unchanged({
            text: Messages.modelNotStored(path, Errno.code(error)),
          }),
      ),
    )
  }
})

/** What `chad model` and `/model` print with no argument: the settings in force and the login state (MOD-19). */
export const shown = (settings: Settings, login: string) =>
  Messages.modelShown({
    main: Result.isSuccess(settings.main)
      ? `${settings.main.success.text} (${login})`
      : Messages.modelCannotRun(
          settings.main.failure.text,
          settings.main.failure.error,
        ),
    subagent: settings.subagent?.text,
    summarizer: settings.summarizer?.text,
    ignored: settings.ignored.map((ignored) =>
      Messages.modelIgnored(ignored.override, ignored.text, ignored.error),
    ),
  })
