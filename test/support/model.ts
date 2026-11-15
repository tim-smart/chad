// The fake model server of docs/spec/17-testing.md. It is an HTTP server that the test starts, scripted by call index,
// and a script can hold a response until the test releases it. It speaks the `openai-compat` endpoint, the Responses
// endpoint of `openai` with a key, and Codex: the device-code, token and model endpoints, the model over HTTP and over
// WebSocket (TST-37). Its Codex side refuses what Codex refuses (TST-40). The check at start and a trial request send
// the fixed prompt, which the fake answers outside the script, so a scenario's call indexes are its turns' alone.
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { Effect, Exit, Scope } from "effect"
import { Socket } from "effect/socket"
import { modelTrial } from "../../dist/Trial.js"

/** What the fake answers to one call. */
export interface Reply {
  /** The answer's text, sent as one streamed chunk. */
  readonly text?: string
  /** A tool the model calls in place of an answer. clanka offers one, `execute`, whose argument is a script. */
  readonly tool?: { readonly name: string; readonly arguments: unknown }
  /** An HTTP status other than 200, sent with no body of a completion. */
  readonly status?: number
  /** Whether the response waits until the test releases it. */
  readonly hold?: boolean
  /**
   * The reply when the call is clanka's summarizer, which sends no tool results, in place of this one. A compaction
   * runs beside the turn, so which of the two takes a call index is not known in advance.
   */
  readonly summary?: Reply
  /** Whether the response leaves out its usage, as a provider that reports none does. */
  readonly unmetered?: boolean
  /** What the call used, in place of one token in and one out. `reasoning` is a part of `output`. */
  readonly usage?: {
    readonly input: number
    readonly output: number
    readonly cached?: number
    readonly reasoning?: number
  }
}

/** A call the fake received. A call on a WebSocket has the headers of the request that opened its socket. */
export interface Call {
  readonly index: number
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

/** The request that opened a WebSocket to the fake's Codex side. */
export interface Opened {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

/** A Codex token as the token store holds it, in clanka's encoding of `TokenData`. */
export interface StoredToken {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId: string
}

/** The name of the token's file in `secrets/auth/`: clanka's key, `codex.auth/token`, as the file store encodes it. */
export const tokenFileName = encodeURIComponent("codex.auth/token")

/** The models a Codex login accepts (MOD-71). */
export const accepted: ReadonlyArray<string> = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
]

export interface FakeModel {
  /** The value for `CHAD_OPENAI_API_URL`. */
  readonly url: string
  /** Where the test's client sends Codex's two hosts: the model endpoint and the login's issuer (TST-38). */
  readonly codex: string
  readonly auth: string
  /** Where the test's WebSocket constructor sends a socket to the Codex model endpoint. */
  readonly socket: string
  /** The requests that opened a WebSocket, oldest first. */
  readonly opened: () => ReadonlyArray<Opened>
  /** The requests of the check at start and of trial requests, which the script does not see. */
  readonly checks: () => ReadonlyArray<Call>
  /** Makes every later check fail with the HTTP status, or answer again with `undefined`. */
  readonly failChecks: (status: number | undefined) => void
  /** A new Codex token that the fake accepts, or one whose access token has expired and whose refresh is good. */
  readonly token: (options?: { readonly expired?: boolean }) => StoredToken
  /** The refresh tokens the login exchanged, oldest first. */
  readonly refreshed: () => ReadonlyArray<string>
  /** How many device codes the login asked for. */
  readonly deviceCodes: () => number
  /** Lets the pending device flow's poll succeed. */
  readonly approve: () => void
  /** Sets the replies, by call index from 0, and forgets the calls received so far. */
  readonly script: (replies: ReadonlyArray<Reply>) => void
  /** Lets the held response of a call go. */
  readonly release: (index: number) => void
  readonly calls: () => ReadonlyArray<Call>
  /** Resolves with the calls once the fake has received `count` of them. */
  readonly received: (count: number) => Promise<ReadonlyArray<Call>>
  readonly close: () => Promise<void>
}

const chunk = (delta: object, finish: string | null) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 0,
  model: "fake",
  choices: [{ index: 0, delta, finish_reason: finish }],
})

/** The reply that makes the model run a script, which is how the agent runs a command. */
export const runs = (script: string): Reply => ({
  tool: { name: "execute", arguments: { script } },
})

/** The items a call sends: the messages of a chat completion, or the input of a Responses request. */
const items = (body: unknown): ReadonlyArray<Record<string, unknown>> => {
  const value = body as { messages?: unknown; input?: unknown } | null
  const list = value?.messages ?? value?.input
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []
}

/** Whether a call sends the results of tools, which clanka's summarizer never does. */
const hasResults = (body: unknown) =>
  items(body).some(
    (item) =>
      item["role"] === "tool" || item["type"] === "function_call_output",
  )

/** The text of an item's content, which is a string or a list of parts. */
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => String((part as { text?: unknown }).text ?? ""))
          .join("")
      : ""

/** Whether a call is the check at start or a trial request, by its fixed prompt (MOD-86). */
const isTrial = (body: unknown) => {
  const users = items(body).filter((item) => item["role"] === "user")
  return users.length === 1 && textOf(users[0]?.["content"]) === modelTrial
}

/** What a call carries as the results of the tools the model called before it, oldest first. */
export const results = (call: Call | undefined): ReadonlyArray<string> =>
  items(call?.body)
    .filter(
      (item) =>
        item["role"] === "tool" || item["type"] === "function_call_output",
    )
    .map((item) =>
      item["role"] === "tool"
        ? String(item["content"])
        : textOf(item["output"]),
    )

/** A line that effect's default logger printed into a script's output, as plain clanka prints its own (FAIL-23). */
const logged = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] [A-Z]+ \(#\d+\): .*\n?/gm

/** The results of a call with the log lines taken out, which leaves what the scripts and their commands printed. */
export const printed = (call: Call | undefined): ReadonlyArray<string> =>
  results(call).map((result) => result.replaceAll(logged, ""))

export interface Options {
  /** The address and the port to listen on, in place of this machine's own address and a free port. */
  readonly host?: string
  readonly port?: number
  /** Called with each call as it arrives, for an event log. */
  readonly heard?: (call: Call) => void
}

/** The events of a chat completion's stream. */
const completion = (index: number, reply: Reply): ReadonlyArray<object> => {
  // A tool call is one entry of the delta's `tool_calls`, with its arguments as JSON text, and it ends the
  // response with `tool_calls` where an answer ends it with `stop`.
  const { tool } = reply
  const events: Array<object> = [
    tool === undefined
      ? chunk({ role: "assistant", content: reply.text ?? "" }, null)
      : chunk(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `call_${index}`,
                type: "function",
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.arguments),
                },
              },
            ],
          },
          null,
        ),
    chunk({}, tool === undefined ? "stop" : "tool_calls"),
  ]
  if (reply.unmetered !== true)
    events.push({
      ...chunk({}, null),
      choices: [],
      usage: {
        prompt_tokens: reply.usage?.input ?? 1,
        completion_tokens: reply.usage?.output ?? 1,
        total_tokens: (reply.usage?.input ?? 1) + (reply.usage?.output ?? 1),
        prompt_tokens_details: { cached_tokens: reply.usage?.cached ?? 0 },
        completion_tokens_details: {
          reasoning_tokens: reply.usage?.reasoning ?? 0,
        },
      },
    })
  return events
}

/** The events of a Responses stream, which Codex sends as server-sent events and as WebSocket frames alike. */
const responses = (
  index: number,
  reply: Reply,
  model: string,
): ReadonlyArray<object> => {
  const response = {
    id: `resp_${index}`,
    object: "response",
    model,
    created_at: 0,
    output: [],
  }
  const { tool } = reply
  const done =
    tool === undefined
      ? {
          type: "message",
          id: `msg_${index}`,
          role: "assistant",
          content: [
            { type: "output_text", text: reply.text ?? "", annotations: [] },
          ],
          status: "completed",
        }
      : {
          type: "function_call",
          id: `fc_${index}`,
          call_id: `call_${index}`,
          name: tool.name,
          arguments: JSON.stringify(tool.arguments),
          status: "completed",
        }
  const usage = {
    input_tokens: reply.usage?.input ?? 1,
    output_tokens: reply.usage?.output ?? 1,
    total_tokens: (reply.usage?.input ?? 1) + (reply.usage?.output ?? 1),
    input_tokens_details: { cached_tokens: reply.usage?.cached ?? 0 },
    output_tokens_details: { reasoning_tokens: reply.usage?.reasoning ?? 0 },
  }
  return [
    { type: "response.created", response },
    {
      type: "response.output_item.added",
      output_index: 0,
      item:
        tool === undefined
          ? { ...done, content: [], status: "in_progress" }
          : { ...done, arguments: "", status: "in_progress" },
    },
    tool === undefined
      ? {
          type: "response.output_text.delta",
          item_id: done.id,
          output_index: 0,
          content_index: 0,
          delta: reply.text ?? "",
        }
      : {
          type: "response.function_call_arguments.delta",
          item_id: done.id,
          output_index: 0,
          delta: (done as { arguments: string }).arguments,
        },
    { type: "response.output_item.done", output_index: 0, item: done },
    {
      type: "response.completed",
      response: {
        ...response,
        output: [done],
        ...(reply.unmetered === true ? {} : { usage }),
      },
    },
  ]
}

/** A refusal: its HTTP status and the error object Codex sends. */
interface Refusal {
  readonly status: number
  readonly error: {
    readonly type?: string
    readonly code?: string
    readonly message: string
  }
}

const headersOf = (request: IncomingMessage): Record<string, string> =>
  Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name,
      String(value),
    ]),
  )

/** Starts the fake. The image layer tells it where to listen, because its daemon is in another container. */
export const start = async (options: Options = {}): Promise<FakeModel> => {
  const host = options.host ?? "127.0.0.1"
  let replies: ReadonlyArray<Reply> = []
  let calls: Array<Call> = []
  const checks: Array<Call> = []
  let checkFailure: number | undefined
  const held = new Map<number, () => void>()
  const released = new Set<number>()
  const waiting: Array<() => void> = []
  const opened: Array<Opened> = []
  // The access tokens the fake issued, with when each expires, and the refresh tokens that are still good.
  const access = new Map<string, number>()
  const refreshes = new Set<string>()
  const refreshed: Array<string> = []
  let issued = 0
  let deviceCodes = 0
  let approved = false

  const issue = (expired: boolean): StoredToken => {
    const n = ++issued
    const token = {
      access: `fake-access-${n}-${Math.random().toString(36).slice(2)}`,
      refresh: `fake-refresh-${n}-${Math.random().toString(36).slice(2)}`,
      expires: expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
      accountId: "fake-account",
    }
    access.set(token.access, token.expires)
    refreshes.add(token.refresh)
    return token
  }

  /** What Codex refuses: an access token it did not issue or that expired, `max_output_tokens`, a model it does not take. */
  const refused = (
    headers: Readonly<Record<string, string>>,
    body: unknown,
  ): Refusal | undefined => {
    const bearer = (headers["authorization"] ?? "").replace(/^Bearer /, "")
    const expires = access.get(bearer)
    if (expires === undefined || expires < Date.now()) {
      return {
        status: 401,
        error: {
          type: "invalid_request_error",
          code: "token_expired",
          message:
            "Provided authentication token is expired. Please try signing in again.",
        },
      }
    }
    if (body === null || typeof body !== "object") return undefined
    if ("max_output_tokens" in body) {
      return {
        status: 400,
        error: {
          type: "invalid_request_error",
          message: "Unsupported parameter: max_output_tokens",
        },
      }
    }
    const model = String((body as { model?: unknown }).model)
    if (!accepted.includes(model)) {
      return {
        status: 400,
        error: {
          type: "invalid_request_error",
          code: "model_not_found",
          message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
        },
      }
    }
    return undefined
  }

  /**
   * The reply to a model call, or the refusal: the check's own answer for the fixed prompt, and the script's reply by
   * call index for any other call. A held reply waits here until the test releases it.
   */
  const answer = async (
    call: Omit<Call, "index">,
    codex: boolean,
  ): Promise<{ readonly index: number; readonly reply: Reply } | Refusal> => {
    const refusal = codex ? refused(call.headers, call.body) : undefined
    if (isTrial(call.body)) {
      checks.push({ ...call, index: checks.length })
      if (refusal !== undefined) return refusal
      return checkFailure === undefined
        ? { index: -1, reply: { text: "ok" } }
        : { status: checkFailure, error: { message: "scripted check failure" } }
    }
    const index = calls.length
    const recorded = { ...call, index }
    calls.push(recorded)
    options.heard?.(recorded)
    for (const wake of waiting.splice(0)) wake()
    if (refusal !== undefined) return refusal
    const scripted = replies[index]
    const reply =
      scripted?.summary !== undefined && !hasResults(call.body)
        ? scripted.summary
        : scripted
    if (reply === undefined) {
      return {
        status: 500,
        error: { message: `the script has no reply for call ${index}` },
      }
    }
    if (reply.hold === true && !released.has(index)) {
      await new Promise<void>((resolve) => held.set(index, resolve))
    }
    if (reply.status !== undefined && reply.status !== 200) {
      return { status: reply.status, error: { message: "scripted failure" } }
    }
    return { index, reply }
  }

  const json = (
    response: import("node:http").ServerResponse,
    status: number,
    body: unknown,
  ) => {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  }

  /** The login's issuer: the device code, its poll, and the token endpoint's two grants. */
  const login = (
    path: string,
    text: string,
    response: import("node:http").ServerResponse,
  ) => {
    if (path === "/auth/api/accounts/deviceauth/usercode") {
      deviceCodes++
      approved = false
      return json(response, 200, {
        device_auth_id: `device-${deviceCodes}`,
        user_code: `FAKE-${deviceCodes}`,
        interval: "0",
      })
    }
    if (path === "/auth/api/accounts/deviceauth/token") {
      return approved
        ? json(response, 200, {
            authorization_code: `code-${deviceCodes}`,
            code_verifier: "verifier",
          })
        : json(response, 403, { error: "authorization_pending" })
    }
    if (path === "/auth/oauth/token") {
      const form = new URLSearchParams(text)
      const grant = form.get("grant_type")
      const refresh = form.get("refresh_token") ?? ""
      if (grant === "refresh_token" && !refreshes.delete(refresh)) {
        return json(response, 401, { error: "invalid_grant" })
      }
      if (grant === "refresh_token") refreshed.push(refresh)
      const token = issue(false)
      return json(response, 200, {
        access_token: token.access,
        refresh_token: token.refresh,
        expires_in: 3600,
      })
    }
    return json(response, 404, { error: { message: `no endpoint ${path}` } })
  }

  const server = createServer((request, response) => {
    const parts: Array<Buffer> = []
    request.on("data", (part: Buffer) => parts.push(part))
    request.on("end", async () => {
      const path = request.url ?? ""
      const text = Buffer.concat(parts).toString("utf8")
      if (path.startsWith("/auth/")) return login(path, text, response)
      const call = {
        path,
        headers: headersOf(request),
        body: text === "" ? null : JSON.parse(text),
      }
      const responsesApi = path.endsWith("/responses")
      const result = await answer(call, path.startsWith("/codex/"))
      if ("status" in result)
        return json(response, result.status, { error: result.error })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const events = responsesApi
        ? responses(
            result.index,
            result.reply,
            String((call.body as { model?: unknown } | null)?.model),
          )
        : completion(result.index, result.reply)
      for (const event of events) {
        const type = (event as { type?: string }).type
        response.write(
          (type === undefined ? "" : `event: ${type}\n`) +
            `data: ${JSON.stringify(event)}\n\n`,
        )
      }
      response.end(responsesApi ? "" : "data: [DONE]\n\n")
    })
  })
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, host, resolve),
  )
  const { port } = server.address() as AddressInfo

  // The Codex model endpoint over WebSocket. The opening request carries the headers, and every `response.create`
  // message on the socket is a call with them (MOD-32). A refusal is an `error` frame, as Codex sends one.
  const scope = Effect.runSync(Scope.make())
  const sockets = await Effect.runPromise(
    NodeSocketServer.makeWebSocket({
      host,
      port: 0,
      verifyClient: (info, done) => {
        opened.push({ path: info.req.url ?? "", headers: headersOf(info.req) })
        done(true)
      },
    }).pipe(Scope.provide(scope)),
  )
  let count = 0
  const connection = (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const opening = opened[count++]!
      const writer = yield* socket.writer
      const send = (frame: object) =>
        Effect.runPromise(
          writer.write(JSON.stringify(frame)).pipe(Effect.ignore),
        )
      const pull = yield* Socket.readerString(socket)
      yield* Effect.forever(
        Effect.flatMap(pull, (frames) =>
          Effect.sync(() => {
            for (const frame of frames) {
              const { type: _type, ...body } = JSON.parse(frame) as {
                type?: string
              }
              void answer(
                { path: opening.path, headers: opening.headers, body },
                true,
              ).then(async (result) => {
                if ("status" in result) {
                  return send({
                    type: "error",
                    status: result.status,
                    error: result.error,
                  })
                }
                for (const event of responses(
                  result.index,
                  result.reply,
                  String((body as { model?: unknown }).model),
                )) {
                  await send(event)
                }
              })
            }
          }),
        ),
      )
    }).pipe(Effect.scoped, Effect.ignore)
  Effect.runFork(
    sockets.run(connection).pipe(Effect.ignore, Scope.provide(scope)),
  )
  const address = sockets.address
  const socketPort = address._tag === "UnixPathAddress" ? 0 : address.port

  return {
    url: `http://127.0.0.1:${port}/v1`,
    codex: `http://127.0.0.1:${port}/codex`,
    auth: `http://127.0.0.1:${port}/auth`,
    socket: `ws://127.0.0.1:${socketPort}/codex`,
    opened: () => opened,
    checks: () => checks,
    failChecks: (status) => {
      checkFailure = status
    },
    token: (options) => issue(options?.expired === true),
    refreshed: () => refreshed,
    deviceCodes: () => deviceCodes,
    approve: () => {
      approved = true
    },
    script: (next) => {
      replies = next
      calls = []
      held.clear()
      released.clear()
    },
    release: (index) => {
      released.add(index)
      held.get(index)?.()
    },
    calls: () => calls,
    received: async (count) => {
      while (calls.length < count) {
        await new Promise<void>((resolve) => waiting.push(resolve))
      }
      return calls
    },
    close: async () => {
      for (const release of held.values()) release()
      await Effect.runPromise(Scope.close(scope, Exit.void))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
