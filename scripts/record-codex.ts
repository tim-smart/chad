/**
 * The recorder of the Codex side (TST-216, which settles TST-G22). Tim runs it once on his own machine, with his own
 * Codex login, and no test or job runs it on a real login:
 *
 *   nix develop -c pnpm build
 *   nix develop -c node scripts/record-codex.ts [--out <file>] [--model <setting>] [--refused-model <model>]
 *   nix develop -c node scripts/record-codex.ts --usage-limit [--out <file>]
 *
 * It logs in by the device flow into a token store held in memory, so no token reaches the disk, and drives clanka's
 * Codex model as chad builds it (src/ModelSpec.ts) through the flows of TST-39 that reach the Codex side and the
 * refusals of TST-40. It records each HTTP exchange and each socket frame, strips them with test/support/recording.ts
 * (TST-41), and writes nothing when a token, the account id or a code of the login is still in the result.
 * docs/build/codex-capture.md is the procedure.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Codex from "clanka/Codex"
import { CodexAuth } from "clanka/CodexAuth"
import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  Result,
  Schema,
  Stream,
} from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { KeyValueStore } from "effect/persistence"
import { Socket } from "effect/socket"
import * as prettier from "prettier"
import * as Spec from "../dist/ModelSpec.js"
import { fallback } from "../dist/ModelText.js"
import {
  type Flow,
  leftover,
  type Recording,
  strip,
} from "../test/support/recording.ts"

const root = join(import.meta.dirname, "..")

/** Where the recording goes unless `--out` names a file. It is committed, and the builder moves it over the fixture. */
export const defaultOut = join(root, "test/unit/fixtures/codex-recording.json")

export interface Options {
  readonly out: string
  /** The model setting to record on, in clanka's format. It must be on the Codex login. */
  readonly model?: string
  /** A model that a Codex login does not accept (TST-40). */
  readonly refusedModel?: string
  /** Records only the usage limit, into the recording that `out` already holds. */
  readonly usageLimit?: boolean
  /** The client every HTTP request goes through. A test passes one that rewrites the Codex hosts to the fake (TST-38). */
  readonly http: Layer.Layer<HttpClient.HttpClient>
  readonly webSocket: Layer.Layer<Socket.WebSocketConstructor>
  /** Tells the person the device code. */
  readonly onCode: (verifyUrl: string, code: string) => void
  /**
   * How the socket of the reconnect flow goes away: `idle` waits out the client's idle time of 60 seconds, which is
   * the flow of TST-39, and `close` closes it from the client at once, for a test.
   */
  readonly reconnect?: "idle" | "close"
  readonly log?: (line: string) => void
}

/** What a run did: whether it wrote, each flow's outcome, and where a secret was left when it refused to write. */
export interface Outcome {
  readonly written: boolean
  readonly flows: Readonly<Record<string, string>>
  readonly missing: ReadonlyArray<string>
  readonly leftover: ReadonlyArray<string>
}

const decoder = new TextDecoder()

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The events of a server-sent event stream, each `data` as JSON. */
const sse = (text: string) =>
  text
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data !== "" && data !== "[DONE]")
    .map(parsed)

/** The fields of a token response or a login exchange whose values are secret, wherever the recorder sees them. */
const secretFields = [
  "access_token",
  "refresh_token",
  "id_token",
  "device_auth_id",
  "user_code",
  "authorization_code",
  "code_verifier",
  "account_id",
  "chatgpt_account_id",
  "chatgpt_user_id",
  "user_id",
  "email",
  "sub",
]

/** The claims of a JWT, or nothing. */
const claims = (token: string): Record<string, unknown> | undefined => {
  const payload = token.split(".")[1]
  if (payload === undefined) return undefined
  const value = parsed(Buffer.from(payload, "base64url").toString("utf8"))
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/** A usage limit, as an error frame of the socket or the error body of an HTTP response. */
const isUsageLimit = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const error = (value as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return false
  const { type, code } = error as { type?: unknown; code?: unknown }
  return type === "usage_limit_reached" || code === "usage_limit_reached"
}

class Log {
  readonly flows: Record<
    string,
    { note: string; outcome: string; events: Array<object> }
  > = {}
  readonly known = new Set<string>()
  readonly sockets = new Set<Socket.WebSocketLike>()
  current: Array<object> = []
  http = 0
  socket = 0

  add(event: object) {
    this.current.push(event)
  }

  /** Notes a value as secret, with the claims of a JWT, so the check before writing looks for it. */
  secret(value: unknown) {
    if (typeof value !== "string" || value.length < 4) return
    this.known.add(value)
    const bearer = value.replace(/^Bearer /i, "")
    this.known.add(bearer)
    for (const part of bearer.split(".").slice(1)) {
      if (part.length >= 16) this.known.add(part)
    }
    for (const [key, claim] of Object.entries(claims(bearer) ?? {})) {
      if (/email|account|user|sub|org/i.test(key)) this.secretsOf(claim, key)
    }
  }

  /** Notes the secret values of a body, a form or a set of headers, by field name. */
  secretsOf(value: unknown, key?: string) {
    if (key !== undefined && typeof value === "string") {
      if (
        secretFields.includes(key) ||
        /^(authorization|chatgpt-account-id|cookie|set-cookie)$/i.test(key)
      ) {
        this.secret(value)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) this.secretsOf(item, key)
      return
    }
    if (typeof value === "object" && value !== null) {
      for (const [name, field] of Object.entries(value)) {
        this.secretsOf(field, name)
      }
    }
  }
}

/** The HTTP client the recorder's model and login use: each exchange is noted, with its body read in full. */
const recordingHttp = (log: Log) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return HttpClient.make((request) =>
        Effect.gen(function* () {
          const n = ++log.http
          const headers = { ...request.headers }
          log.secretsOf(headers)
          const body = request.body
          const text =
            body._tag === "Uint8Array" ? decoder.decode(body.body) : undefined
          const form =
            text !== undefined &&
            body._tag === "Uint8Array" &&
            body.contentType.includes("x-www-form-urlencoded")
              ? Object.fromEntries(new URLSearchParams(text))
              : undefined
          const json =
            text !== undefined && form === undefined ? parsed(text) : undefined
          // Every field of a form but these is a token or a code of the login, as the stripper takes it.
          for (const [name, field] of Object.entries(form ?? {})) {
            if (
              !["grant_type", "client_id", "redirect_uri", "scope"].includes(
                name,
              )
            ) {
              log.secret(field)
            }
          }
          log.secretsOf(json)
          log.add({
            http: n,
            request: {
              method: request.method,
              url: request.url,
              headers,
              ...(form === undefined ? {} : { form }),
              ...(json === undefined ? {} : { json }),
            },
          })
          const response = yield* client.execute(request)
          const answer = yield* response.text
          const type = response.headers["content-type"] ?? ""
          const content = type.includes("text/event-stream")
            ? { events: sse(answer) }
            : answer === ""
              ? {}
              : { json: parsed(answer) }
          log.secretsOf(content)
          log.secretsOf(response.headers)
          log.add({
            http: n,
            response: {
              status: response.status,
              headers: { ...response.headers },
              ...content,
            },
          })
          return HttpClientResponse.fromWeb(
            request,
            new Response(answer === "" ? null : answer, {
              status: response.status,
              headers: response.headers,
            }),
          )
        }),
      )
    }),
  )

/** The WebSocket constructor the recorder's model uses: each opening, frame, close and error is noted. */
const recordingSockets = (log: Log) =>
  Layer.effect(
    Socket.WebSocketConstructor,
    Effect.map(Socket.WebSocketConstructor, (make) => (url, options) => {
      const n = ++log.socket
      const headers =
        typeof options === "object" && !Array.isArray(options)
          ? { ...options.headers }
          : {}
      log.secretsOf(headers)
      log.add({ socket: n, open: { url, headers } })
      const ws = make(url, options)
      if ("binaryType" in ws) {
        ;(ws as { binaryType: string }).binaryType = "arraybuffer"
      }
      const frame = (data: unknown) =>
        parsed(
          typeof data === "string" ? data : decoder.decode(data as ArrayBuffer),
        )
      ws.addEventListener("message", (event) => {
        const received = frame(event.data)
        log.secretsOf(received)
        log.add({ socket: n, received })
      })
      ws.addEventListener("close", (event) => {
        log.sockets.delete(like)
        log.add({
          socket: n,
          closed: { code: event.code, reason: event.reason },
        })
      })
      ws.addEventListener("error", (event) => {
        log.add({ socket: n, error: String(event.type ?? "error") })
      })
      const like: Socket.WebSocketLike = {
        get readyState() {
          return ws.readyState
        },
        addEventListener: (type, listener, options) =>
          ws.addEventListener(type, listener, options),
        removeEventListener: (type, listener) =>
          ws.removeEventListener(type, listener),
        close: (code, reason) => ws.close(code, reason),
        send: (data) => {
          const sent = frame(data)
          log.secretsOf(sent)
          log.add({ socket: n, sent })
          ws.send(data)
        },
      }
      log.sockets.add(like)
      return like
    }),
  )

/** clanka's own tool, `execute`, which is the one tool chad's agent calls. */
const Execute = Tool.make("execute", {
  description: "Execute javascript code and return the output",
  parameters: Schema.Struct({ script: Schema.String }),
  success: Schema.String,
})
const tools = Toolkit.make(Execute)
const handlers = tools.toLayer({ execute: () => Effect.succeed("hello") })

/** The instructions of each call, as clanka's agent sends its system prompt. */
const instructions =
  "You answer test prompts for a recording of the Codex protocol. Keep every answer short."

const tokenKey = "codex.auth/token"

/** Runs the recorder and writes the recording, or refuses to (TST-216). */
export const record = (options: Options): Promise<Outcome> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const say = options.log ?? (() => {})
      const log = new Log()
      // A run at the usage limit adds to the recording already made, so it needs one before it asks for a login.
      const previous =
        options.usageLimit === true ? loadOut(options.out) : undefined
      const endpoint = { openaiApiUrl: undefined, openaiApiKey: undefined }
      const spec = Spec.parse(options.model ?? fallback, endpoint)
      if (Result.isFailure(spec) || spec.success.path !== "codex") {
        return yield* Effect.die(
          new Error(
            `${options.model ?? fallback} is not a model on the Codex login`,
          ),
        )
      }
      const main = spec.success
      const refused = Spec.parse(
        `openai/${options.refusedModel ?? "gpt-4.1"}`,
        endpoint,
      )
      if (Result.isFailure(refused)) {
        return yield* Effect.die(new Error(refused.failure))
      }

      const store = yield* KeyValueStore.KeyValueStore.pipe(
        Effect.provide(KeyValueStore.layerMemory),
      )
      const transport = Layer.merge(
        recordingHttp(log).pipe(Layer.provide(options.http)),
        recordingSockets(log).pipe(Layer.provide(options.webSocket)),
      )
      const base = yield* Layer.build(transport)
      // Other providers' logins are never asked for here.
      const noLogin = DeviceCodeHandler.of({
        onCode: () => Effect.die(new Error("no other login")),
      })
      const handler = DeviceCodeHandler.of({
        onCode: ({ verifyUrl, deviceCode }) =>
          Effect.sync(() => options.onCode(verifyUrl, deviceCode)),
      })
      /** clanka's Codex login over a token store, as the daemon builds it. */
      const login = (over: KeyValueStore.KeyValueStore) =>
        CodexAuth.make.pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, over),
          Effect.provideService(DeviceCodeHandler, handler),
          Effect.provide(base),
        )
      let auth = yield* login(store)

      /** The session's model over the socket, as chad builds it (MOD-27, MOD-31, MOD-32). */
      const socketModel = (model: Spec.Spec, session: string) =>
        Spec.languageModel(model, session, endpoint)
      /** The same model over HTTP, which the fake's Codex side also speaks. */
      const httpModel = (model: Spec.Spec, session: string) =>
        Codex.model(model.model, {
          ...(model.effort === undefined
            ? {}
            : { reasoning: { effort: model.effort } }),
          prompt_cache_key: session,
        }).pipe(
          Layer.provide(
            OpenAiClient.layer({ apiUrl: Spec.codexUrl }).pipe(
              Layer.provide(CodexAuth.layerClientNoDeps),
            ),
          ),
        )
      type Built = ReturnType<typeof socketModel>
      const services = (over: CodexAuth["Service"]) =>
        Layer.mergeAll(
          Layer.succeed(CodexAuth, over),
          Layer.succeed(KeyValueStore.KeyValueStore, store),
          Layer.succeed(DeviceCodeHandler, noLogin),
          Layer.succeedContext(base),
        )

      const ask = (
        prompt: Prompt.RawInput,
        extra: { readonly max_output_tokens?: number } = {},
        stopAtText = false,
      ) =>
        LanguageModel.streamText({ prompt }).pipe(
          stopAtText
            ? Stream.takeUntil((part) => part.type === "text-delta")
            : (stream) => stream,
          Stream.runCollect,
          OpenAiLanguageModel.withConfigOverride({ instructions, ...extra }),
        )

      /** Runs one flow on a model layer of its own, and notes how it ended. */
      const flow = <A, E>(
        name: string,
        note: string,
        expect: "answer" | "refusal",
        effect: Effect.Effect<A, E, LanguageModel.LanguageModel>,
        layer: Built | ReturnType<typeof httpModel>,
        over: CodexAuth["Service"] = auth,
      ) =>
        Effect.gen(function* () {
          log.current = []
          const exit = yield* effect.pipe(
            Effect.provide(layer),
            Effect.provide(services(over)),
            Effect.timeout(Duration.minutes(3)),
            Effect.exit,
          )
          const error = Exit.isFailure(exit)
            ? (Cause.pretty(exit.cause).split("\n")[0] ?? "failed")
            : undefined
          const outcome =
            error === undefined
              ? expect === "answer"
                ? "answered"
                : "answered, which the fake refuses"
              : `${expect === "refusal" ? "refused" : "failed"}: ${error}`
          log.flows[name] = { note, outcome, events: log.current }
          say(`${name}: ${outcome}`)
        })

      say("Logging in. Open the link and enter the code.")
      log.current = []
      const loggedIn = yield* auth.get.pipe(
        Effect.provide(base),
        Effect.timeout(Duration.minutes(15)),
        Effect.exit,
      )
      log.flows["login"] = {
        note: "The device flow: the code, its poll and the token exchange (TST-39, the login flow).",
        outcome: Exit.isSuccess(loggedIn)
          ? "logged in"
          : `failed: ${Cause.pretty(loggedIn.cause).split("\n")[0]}`,
        events: log.current,
      }
      say(`login: ${log.flows["login"].outcome}`)
      if (Exit.isFailure(loggedIn)) {
        return yield* Effect.die(new Error(log.flows["login"].outcome))
      }
      const stored = yield* Effect.orDie(store.get(tokenKey))
      if (stored === undefined) {
        return yield* Effect.die(new Error("the login stored no token"))
      }
      const token = JSON.parse(stored) as {
        access: string
        refresh: string
        expires: number
        accountId?: string
      }
      log.secret(token.access)
      log.secret(token.refresh)
      log.secret(token.accountId)

      const session = () => crypto.randomUUID()
      const both = (
        name: string,
        note: string,
        expect: "answer" | "refusal",
        model: Spec.Spec,
        effect: Effect.Effect<unknown, unknown, LanguageModel.LanguageModel>,
        over: CodexAuth["Service"] = auth,
      ) =>
        Effect.andThen(
          flow(
            `${name}`,
            `${note} Over the socket.`,
            expect,
            effect,
            socketModel(model, session()),
            over,
          ),
          flow(
            `${name}-http`,
            `${note} Over HTTP.`,
            expect,
            effect,
            httpModel(model, session()),
            over,
          ),
        )

      if (options.usageLimit === true) {
        yield* both(
          "usage-limit",
          "A call while the login is at its usage limit (TST-39, FAIL-88).",
          "refusal",
          main,
          ask("Answer with the one word: hello."),
        )
      } else {
        yield* both(
          "answer",
          "One call that answers with text (TST-39).",
          "answer",
          main,
          ask("Answer with the one word: hello."),
        )
        const toolPrompt = Prompt.make(
          "Call the execute tool once with a script that prints hello. Then say done.",
        )
        yield* flow(
          "tool-call",
          "A call that calls clanka's execute tool, then the call that carries its result, on one socket (TST-39, a sub-agent and a resumed turn).",
          "answer",
          Effect.gen(function* () {
            const first = yield* LanguageModel.streamText({
              prompt: toolPrompt,
              toolkit: tools,
              toolChoice: { tool: "execute" },
            }).pipe(Stream.runCollect)
            return yield* LanguageModel.streamText({
              prompt: Prompt.concat(
                toolPrompt,
                Prompt.fromResponseParts(first),
              ),
              toolkit: tools,
            }).pipe(Stream.runCollect)
          }).pipe(
            OpenAiLanguageModel.withConfigOverride({ instructions }),
            Effect.provide(handlers),
          ),
          socketModel(main, session()),
        )
        yield* flow(
          "stop",
          "A call stopped at its first text, then the next call on the same model, which shows what the socket sends after a stop (TST-39, Stop during a streaming response).",
          "answer",
          Effect.andThen(
            ask("Count from 1 to 300, one number per line.", {}, true),
            ask("Answer with the one word: done."),
          ),
          socketModel(main, session()),
        )
        const reconnect = options.reconnect ?? "idle"
        yield* flow(
          "reconnect",
          reconnect === "idle"
            ? "A call, 65 seconds idle so the client's socket idles out, and a call on a new socket (TST-39)."
            : "A call, the socket closed by the client, and a call on a new socket (a test's run; TST-39 idles it out).",
          "answer",
          Effect.gen(function* () {
            yield* ask("Answer with the one word: one.")
            if (reconnect === "idle") {
              say("reconnect: waiting 65 seconds for the socket to idle out")
              yield* Effect.sleep(Duration.seconds(65))
            } else {
              const open = [...log.sockets]
              for (const socket of open) socket.close(1000, "recorder")
              while (log.sockets.size > 0)
                yield* Effect.sleep(Duration.millis(10))
              yield* Effect.sleep(Duration.millis(100))
            }
            return yield* ask("Answer with the one word: two.")
          }),
          socketModel(main, session()),
        )
        // The token check finds the access token expired and refreshes it before the call (MOD-27, SES-56).
        yield* Effect.orDie(
          store.set(tokenKey, JSON.stringify({ ...token, expires: 0 })),
        )
        auth = yield* login(store)
        yield* flow(
          "refresh",
          "The stored access token has expired, so the login refreshes it before the call (TST-39, the order of the token check).",
          "answer",
          ask("Answer with the one word: hello."),
          socketModel(main, session()),
        )
        yield* both(
          "refused-model",
          `A model the Codex login does not accept, ${refused.success.model} (TST-40).`,
          "refusal",
          refused.success,
          ask("Answer with the one word: hello."),
        )
        yield* both(
          "max-output-tokens",
          "A call with max_output_tokens (TST-40).",
          "refusal",
          main,
          ask("Answer with the one word: hello.", { max_output_tokens: 16 }),
        )
        // An access token the service did not issue, with the real account id. A token that has expired cannot be made
        // on demand, and clanka refreshes one it knows has expired before sending it.
        const current = JSON.parse(
          (yield* Effect.orDie(store.get(tokenKey))) ?? stored,
        ) as typeof token
        const bad = yield* KeyValueStore.KeyValueStore.pipe(
          Effect.provide(KeyValueStore.layerMemory),
        )
        const access = current.access.includes(".")
          ? `${current.access.slice(0, current.access.lastIndexOf(".") + 1)}invalid`
          : `${current.access}-invalid`
        yield* Effect.orDie(
          bad.set(
            tokenKey,
            JSON.stringify({
              ...current,
              access,
              refresh: "unused",
              expires: Date.now() + 3_600_000,
            }),
          ),
        )
        const badAuth = yield* login(bad)
        yield* both(
          "expired-token",
          "A call with an access token the service did not issue, standing in for an expired one (TST-40).",
          "refusal",
          main,
          ask("Answer with the one word: hello."),
          badAuth,
        )
      }

      // The recording: the flows, and the parts the loader and the fake's comparison read (TST-41).
      const flows: Record<string, Flow> = { ...previous?.flows, ...log.flows }
      const events = (name: string) =>
        (flows[name]?.events ?? []) as ReadonlyArray<{
          readonly open?: { readonly headers: Record<string, string> }
          readonly received?: unknown
        }>
      const limit = Object.values(log.flows)
        .flatMap((one) => one.events as ReadonlyArray<{ received?: unknown }>)
        .map((event) => event.received)
        .find(isUsageLimit)
      const refusal = (limit as object | undefined) ?? previous?.refusal
      const missing = refusal === undefined ? ["usage-limit"] : []
      const clanka = JSON.parse(
        readFileSync(join(root, "node_modules/clanka/package.json"), "utf8"),
      ) as { version: string }
      const recording: Recording = {
        source: `Recorded by scripts/record-codex.ts on a Codex login, model ${options.model ?? fallback}, clanka ${clanka.version}, ${new Date().toISOString().slice(0, 10)}.`,
        opening: {
          headers:
            events("answer").find((event) => event.open)?.open?.headers ?? {},
        },
        answer: events("answer").flatMap((event) =>
          event.received === undefined ? [] : [event.received as object],
        ),
        ...(refusal === undefined ? {} : { refusal }),
        flows,
        missing,
      }
      const result = strip(recording)
      const found = leftover(result, [...log.known])
      const outcomes = Object.fromEntries(
        Object.entries(flows).map(([name, one]) => [name, one.outcome]),
      )
      if (found.length > 0) {
        say(
          `Not written: a secret is left after stripping, at ${found.join(", ")}`,
        )
        return { written: false, flows: outcomes, missing, leftover: found }
      }
      const text = yield* Effect.promise(() =>
        prettier.format(JSON.stringify(result), { parser: "json" }),
      )
      writeFileSync(options.out, text)
      say(`Wrote ${options.out}`)
      return { written: true, flows: outcomes, missing, leftover: [] }
    }).pipe(Effect.scoped),
  )

const loadOut = (file: string): Recording => {
  if (!existsSync(file)) {
    throw new Error(
      `${file} does not exist: run the recorder without --usage-limit first`,
    )
  }
  return JSON.parse(readFileSync(file, "utf8")) as Recording
}

const usage =
  "usage: node scripts/record-codex.ts [--out <file>] [--model <setting>] [--refused-model <model>] [--usage-limit]"

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => {
    const at = args.indexOf(flag)
    return at === -1 ? undefined : args[at + 1]
  }
  const valued = new Set(["--out", "--model", "--refused-model"])
  const wrong = args.some((arg, at) =>
    arg.startsWith("--")
      ? !valued.has(arg) && arg !== "--usage-limit"
      : !valued.has(args[at - 1] ?? ""),
  )
  if (
    wrong ||
    args.some((arg, at) => valued.has(arg) && args[at + 1] === undefined)
  ) {
    console.error(usage)
    process.exit(2)
  }
  const out = value("--out") ?? defaultOut
  if (args.includes("--usage-limit") && !existsSync(out)) {
    console.error(
      `${out} does not exist: run the recorder without --usage-limit first`,
    )
    process.exit(2)
  }
  const model = value("--model")
  const refusedModel = value("--refused-model")
  const outcome = await record({
    out,
    ...(model === undefined ? {} : { model }),
    ...(refusedModel === undefined ? {} : { refusedModel }),
    usageLimit: args.includes("--usage-limit"),
    http: NodeHttpClient.layerUndici,
    webSocket: NodeSocket.layerWebSocketConstructor,
    onCode: (verifyUrl, code) =>
      console.log(`Open ${verifyUrl} and enter ${code}`),
    log: (line) => console.log(line),
  })
  if (outcome.missing.length > 0) {
    console.log(
      `Not provoked: ${outcome.missing.join(", ")}. See docs/build/codex-capture.md.`,
    )
  }
  process.exit(outcome.written ? 0 : 1)
}
