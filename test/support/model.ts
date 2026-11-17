// The fake model server of the tests. It is an HTTP server that the test starts, scripted by call index, and a script
// can hold a response until the test releases it. It speaks the `openai-compat` endpoint, the Responses endpoint of
// `openai` with a key, and Codex: the device-code, token and model endpoints, the model over HTTP and over WebSocket.
// Its Codex side refuses what Codex refuses. The check at start and a trial request send the fixed prompt, and a thread's
// title request the title's, which the fake answers outside the script, so a scenario's call indexes are its turns' alone.
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { Effect, Exit, Scope } from "effect"
import { Socket } from "effect/socket"
import { titleInstruction } from "../../dist/Title.js"
import { modelTrial } from "../../dist/Trial.js"

/** What the fake answers to one call. */
export interface Reply {
  /** The answer's text, sent as one streamed chunk. */
  readonly text?: string
  /** A tool the model calls in place of an answer. clanka offers one, `execute`, whose argument is a script. */
  readonly tool?: { readonly name: string; readonly arguments: unknown }
  /** An HTTP status other than 200, sent with no body of a completion. */
  readonly status?: number
  /**
   * The provider's error object, sent with `status` in place of the fake's own: the body of an HTTP refusal, or the
   * `error` of a WebSocket error frame, such as a usage limit's.
   */
  readonly error?: Refusal["error"]
  /** Whether the response waits until the test releases it. */
  readonly hold?: boolean
  /**
   * Whether the answer's text streams until the test releases it: the response starts, and a delta follows every 50 ms
   * until the release, as a model that answers at length sends one. clanka shows such an agent's output and holds back
   * the other shown agents' parts while it runs (`Agent.ts:432-470`).
   */
  readonly stream?: boolean
  /**
   * The reply when the call is clanka's summarizer, which sends no tool results, in place of this one. A compaction
   * runs beside the turn, so which of the two takes a call index is not known in advance.
   */
  readonly summary?: Reply
  /** Whether the response leaves out its usage, as a provider that reports none does. */
  readonly unmetered?: boolean
  /**
   * The error a Responses stream fails with, in `response.failed` after the response starts and in place of the answer.
   * No failed response was recorded, so it follows the pattern of the recorded `response.completed`.
   */
  readonly failed?: { readonly code: string; readonly message: string }
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

/** The models a Codex login accepts. */
export const accepted: ReadonlyArray<string> = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
]

export interface FakeModel {
  /** The value for `CHAD_OPENAI_API_URL`. */
  readonly url: string
  /** Where the test's client sends Codex's two hosts: the model endpoint and the login's issuer. */
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
  /**
   * Holds every check of one model until `release` is called. `reached` resolves when the first of them arrives.
   */
  readonly holdChecks: (model: string) => {
    readonly reached: Promise<void>
    readonly release: () => void
  }
  /** The title requests, which the script does not see, oldest first. */
  readonly titles: () => ReadonlyArray<Call>
  /**
   * The reply to every later title request, in place of the fake's own title: its `text`, or its `status` as a refusal.
   * With `hold`, each of them waits for `release`. `reached` resolves when the first of them arrives, and `abandoned`
   * when the client of one went away before its answer.
   */
  readonly title: (reply: Reply) => {
    readonly reached: Promise<void>
    readonly release: () => void
    readonly abandoned: Promise<void>
  }
  /**
   * Holds every later refresh of a Codex token until `release` is called. `reached` resolves when the first of them
   * arrives.
   */
  readonly holdRefreshes: () => {
    readonly reached: Promise<void>
    readonly release: () => void
  }
  /** A new Codex token that the fake accepts, or one whose access token has expired and whose refresh is good. */
  readonly token: (options?: { readonly expired?: boolean }) => StoredToken
  /** The refresh tokens the login exchanged, oldest first. */
  readonly refreshed: () => ReadonlyArray<string>
  /** How many device codes the login asked for. */
  readonly deviceCodes: () => number
  /** Lets the pending device flow's poll succeed, and answers the polls that `holdPolls` holds. */
  readonly approve: () => void
  /**
   * From now on, a poll of a device code that is not approved yet waits for `approve` in place of Codex's
   * `authorization_pending`. The login then ends as soon as the test approves, and not at clanka's next poll, which
   * is 8 seconds later: clanka reads the fake's interval of 0 as its default of 5 seconds and adds 3.
   */
  readonly holdPolls: () => void
  /** Sets the replies, by call index from 0, and forgets the calls received so far. */
  readonly script: (replies: ReadonlyArray<Reply>) => void
  /**
   * The replies, in their own order, to the calls whose request holds `marker`, such as a sub-agent's task. Those calls
   * take no reply of the script, and the calls the routes do not take get the script's replies in order. Two agents that
   * call at once can each be given their own replies so.
   */
  readonly route: (marker: string, replies: ReadonlyArray<Reply>) => Route
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

/** The calls of one route of the fake (`FakeModel.route`). */
export interface Route {
  readonly calls: () => ReadonlyArray<Call>
  /** Resolves once the route has taken `count` calls. */
  readonly received: (count: number) => Promise<ReadonlyArray<Call>>
}

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

/** Whether a call is the check at start or a trial request, by its fixed prompt. */
const isTrial = (body: unknown) => {
  const users = items(body).filter((item) => item["role"] === "user")
  return users.length === 1 && textOf(users[0]?.["content"]) === modelTrial
}

/** Whether a call is a thread's title request, by the first line of its prompt. */
const isTitle = (body: unknown) => {
  const users = items(body).filter((item) => item["role"] === "user")
  return (
    users.length === 1 &&
    textOf(users[0]?.["content"]).startsWith(titleInstruction)
  )
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

/** A line that effect's default logger printed into a script's output, as plain clanka prints its own. */
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

/** A refusal on the Codex socket, as an `error` frame with the status and the provider's error. */
export const refusalFrame = (refusal: Refusal) => ({
  type: "error",
  status: refusal.status,
  error: refusal.error,
})

/** The token counts of one entry of a recorded `usage.attribution`. */
const counts = (input: number, output: number, cached = 0) => ({
  cache_write_tokens: 0,
  cached_tokens: cached,
  input_tokens: input,
  output_tokens: output,
})

/**
 * The events of a Responses stream, which Codex sends as server-sent events and as WebSocket frames alike. Their shape
 * is the kept recording's, which has every field the proxy relayed, the image tool it adds among them. An answer is the
 * nine event types of the recording, and a tool call, which was not recorded, follows the same pattern.
 */
export const responses = (
  index: number,
  reply: Reply,
  model: string,
): ReadonlyArray<object> => {
  const response = {
    id: `resp_${index}`,
    object: "response",
    created_at: 0,
    status: "in_progress",
    access_programs: {},
    background: false,
    completed_at: null,
    error: null,
    frequency_penalty: 0,
    image: { context_compression: "disabled" },
    incomplete_details: null,
    input_transformations: [],
    instructions: "",
    max_output_tokens: null,
    max_tool_calls: null,
    model,
    moderation: null,
    output: [],
    parallel_tool_calls: true,
    presence_penalty: 0,
    previous_response_id: null,
    prompt_cache_key: "",
    prompt_cache_retention: "24h",
    reasoning: {
      context: "all_turns",
      effort: "medium",
      mode: "standard",
      summary: null,
    },
    safety_identifier: "",
    service_tier: "auto",
    store: false,
    temperature: 1,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tool_usage: {
      image_gen: {
        input_tokens: 0,
        input_tokens_details: { image_tokens: 0, text_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { image_tokens: 0, text_tokens: 0 },
        total_tokens: 0,
      },
      web_search: { num_requests: 0 },
    },
    tools: [
      {
        type: "image_generation",
        background: "auto",
        model: "gpt-image-2-codex",
        moderation: "auto",
        n: 1,
        output_compression: 100,
        output_format: "png",
        quality: "auto",
        size: "auto",
      },
    ],
    top_logprobs: 0,
    top_p: 0.98,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  }
  const numbered = (events: ReadonlyArray<object>) =>
    events.map((event, sequence_number) => ({ ...event, sequence_number }))
  if (reply.failed !== undefined) {
    return numbered([
      { type: "response.created", response },
      { type: "response.in_progress", response },
      {
        type: "response.failed",
        response: { ...response, status: "failed", error: reply.failed },
      },
    ])
  }
  const { tool } = reply
  const text = reply.text ?? ""
  const part = { type: "output_text", annotations: [], logprobs: [], text }
  const done =
    tool === undefined
      ? {
          id: `msg_${index}`,
          type: "message",
          status: "completed",
          content: [part],
          phase: "final_answer",
          role: "assistant",
        }
      : {
          id: `fc_${index}`,
          type: "function_call",
          status: "completed",
          arguments: JSON.stringify(tool.arguments),
          call_id: `call_${index}`,
          name: tool.name,
        }
  const input = reply.usage?.input ?? 1
  const output = reply.usage?.output ?? 1
  const cached = reply.usage?.cached ?? 0
  const usage = {
    attribution: {
      items: {
        [`msg_in${index}`]: {
          ...counts(input, 0, cached),
          content: [counts(input, 0, cached)],
        },
        [done.id]: { ...counts(0, output), content: [counts(0, output)] },
      },
      request_fields: { tools: counts(0, 0), instructions: counts(0, 0) },
    },
    input_tokens: input,
    input_tokens_details: {
      cache_write_tokens: 0,
      cache_write_tokens_details: { ttl_12h_tokens: 0, ttl_30m_tokens: 0 },
      cached_tokens: cached,
    },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reply.usage?.reasoning ?? 0 },
    total_tokens: input + output,
  }
  const at = { item_id: done.id, output_index: 0 }
  const events: Array<object> = [
    { type: "response.created", response },
    { type: "response.in_progress", response },
    {
      type: "response.output_item.added",
      item:
        tool === undefined
          ? { ...done, status: "in_progress", content: [] }
          : { ...done, status: "in_progress", arguments: "" },
      output_index: 0,
    },
    ...(tool === undefined
      ? [
          {
            type: "response.content_part.added",
            content_index: 0,
            ...at,
            part: { ...part, text: "" },
          },
          {
            type: "response.output_text.delta",
            content_index: 0,
            delta: text,
            ...at,
            logprobs: [],
            obfuscation: "",
          },
          {
            type: "response.output_text.done",
            content_index: 0,
            ...at,
            logprobs: [],
            text,
          },
          { type: "response.content_part.done", content_index: 0, ...at, part },
        ]
      : [
          {
            type: "response.function_call_arguments.delta",
            ...at,
            delta: (done as { arguments: string }).arguments,
            obfuscation: "",
          },
          {
            type: "response.function_call_arguments.done",
            ...at,
            arguments: (done as { arguments: string }).arguments,
          },
        ]),
    { type: "response.output_item.done", item: done, output_index: 0 },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        completed_at: 0,
        output: [done],
        ...(reply.unmetered === true ? {} : { usage }),
      },
    },
  ]
  return numbered(events)
}

/** A refusal: its HTTP status and the error object Codex sends. */
export interface Refusal {
  readonly status: number
  readonly error: {
    readonly type?: string
    readonly code?: string
    readonly message: string
    /** When a usage limit resets, in epoch seconds, as Codex's HTTP body has it. */
    readonly resets_at?: number
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
  // The calls the script answers so far, which are every call when there are no routes.
  let scripted = 0
  let routes: Array<{
    readonly marker: string
    readonly replies: ReadonlyArray<Reply>
    readonly calls: Array<Call>
  }> = []
  let closed = false
  const checks: Array<Call> = []
  let checkFailure: number | undefined
  const titles: Array<Call> = []
  let titleReply: Reply = { text: "A fake title" }
  let titleGate:
    | {
        readonly reach: () => void
        readonly released: Promise<void>
        readonly abandon: () => void
      }
    | undefined
  let refreshGate:
    { readonly reach: () => void; readonly released: Promise<void> } | undefined
  const heldChecks = new Map<
    string,
    { readonly reach: () => void; readonly released: Promise<void> }
  >()
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
  let holdingPolls = false
  // The answers of the polls that wait for `approve`. A poll whose client went away leaves the set.
  const polls = new Set<() => void>()

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
      const gate = heldChecks.get(
        typeof call.body === "object" &&
          call.body !== null &&
          "model" in call.body
          ? String(call.body.model)
          : "",
      )
      if (gate !== undefined) {
        gate.reach()
        await gate.released
      }
      if (refusal !== undefined) return refusal
      return checkFailure === undefined
        ? { index: -1, reply: { text: "ok" } }
        : { status: checkFailure, error: { message: "scripted check failure" } }
    }
    if (isTitle(call.body)) {
      titles.push({ ...call, index: titles.length })
      const reply = titleReply
      const gate = titleGate
      if (gate !== undefined) {
        gate.reach()
        await gate.released
      }
      if (refusal !== undefined) return refusal
      return reply.status !== undefined && reply.status !== 200
        ? {
            status: reply.status,
            error: reply.error ?? { message: "scripted title failure" },
          }
        : { index: -1, reply }
    }
    const index = calls.length
    const recorded = { ...call, index }
    calls.push(recorded)
    options.heard?.(recorded)
    for (const wake of waiting.splice(0)) wake()
    if (refusal !== undefined) return refusal
    const text = JSON.stringify(call.body)
    const route = routes.find((route) => text.includes(route.marker))
    route?.calls.push(recorded)
    const next =
      route === undefined
        ? replies[scripted++]
        : route.replies[route.calls.length - 1]
    const reply =
      next?.summary !== undefined && !hasResults(call.body)
        ? next.summary
        : next
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
      return {
        status: reply.status,
        error: reply.error ?? { message: "scripted failure" },
      }
    }
    return { index, reply }
  }

  /** The events of a reply in the order they are sent. A streamed reply's deltas go on until the test releases it. */
  const sent = async function* (
    index: number,
    reply: Reply,
    model: string,
  ): AsyncGenerator<object> {
    const events = responses(
      index,
      reply.stream === true ? { ...reply, text: "." } : reply,
      model,
    )
    const delta = events.findIndex(
      (event) =>
        (event as { type?: string }).type === "response.output_text.delta",
    )
    if (reply.stream !== true || delta === -1) return yield* events
    let sequence = 0
    const numbered = (event: object) => ({
      ...event,
      sequence_number: sequence++,
    })
    for (const event of events.slice(0, delta + 1)) yield numbered(event)
    while (!released.has(index) && !closed) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      yield numbered(events[delta]!)
    }
    for (const event of events.slice(delta + 1)) yield numbered(event)
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
  const login = async (
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
      const approval = () =>
        json(response, 200, {
          authorization_code: `code-${deviceCodes}`,
          code_verifier: "verifier",
        })
      if (approved) return approval()
      if (!holdingPolls) {
        return json(response, 403, { error: "authorization_pending" })
      }
      polls.add(approval)
      response.on("close", () => polls.delete(approval))
      return
    }
    if (path === "/auth/oauth/token") {
      const form = new URLSearchParams(text)
      const grant = form.get("grant_type")
      const refresh = form.get("refresh_token") ?? ""
      if (grant === "refresh_token" && !refreshes.delete(refresh)) {
        return json(response, 401, { error: "invalid_grant" })
      }
      if (grant === "refresh_token") refreshed.push(refresh)
      if (grant === "refresh_token" && refreshGate !== undefined) {
        refreshGate.reach()
        await refreshGate.released
      }
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
      // A held title whose client goes away, as when its fiber is interrupted, says so.
      const gate = isTitle(call.body) ? titleGate : undefined
      if (gate !== undefined) {
        response.on("close", () => {
          if (!response.writableEnded) gate.abandon()
        })
      }
      const result = await answer(call, path.startsWith("/codex/"))
      if ("status" in result)
        return json(response, result.status, { error: result.error })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const events = responsesApi
        ? sent(
            result.index,
            result.reply,
            String((call.body as { model?: unknown } | null)?.model),
          )
        : completion(result.index, result.reply)
      for await (const event of events) {
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
  // message on the socket is a call with them. A refusal is an `error` frame, as Codex sends one.
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
                if ("status" in result) return send(refusalFrame(result))
                for await (const event of sent(
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
    holdChecks: (model) => {
      const reached = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      heldChecks.set(model, {
        reach: reached.resolve,
        released: released.promise,
      })
      return {
        reached: reached.promise,
        release: () => {
          heldChecks.delete(model)
          released.resolve()
        },
      }
    },
    failChecks: (status) => {
      checkFailure = status
    },
    titles: () => titles,
    title: (reply) => {
      const reached = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const abandoned = Promise.withResolvers<void>()
      titleReply = reply
      titleGate =
        reply.hold === true
          ? {
              reach: reached.resolve,
              released: released.promise,
              abandon: abandoned.resolve,
            }
          : undefined
      return {
        reached: reached.promise,
        release: released.resolve,
        abandoned: abandoned.promise,
      }
    },
    holdRefreshes: () => {
      const reached = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      refreshGate = { reach: reached.resolve, released: released.promise }
      return {
        reached: reached.promise,
        release: () => {
          refreshGate = undefined
          released.resolve()
        },
      }
    },
    token: (options) => issue(options?.expired === true),
    refreshed: () => refreshed,
    deviceCodes: () => deviceCodes,
    holdPolls: () => {
      holdingPolls = true
    },
    approve: () => {
      approved = true
      const waiting = [...polls]
      polls.clear()
      waiting.forEach((approval) => approval())
    },
    script: (next) => {
      replies = next
      calls = []
      scripted = 0
      routes = []
      held.clear()
      released.clear()
    },
    route: (marker, replies) => {
      const route = { marker, replies, calls: [] as Array<Call> }
      routes.push(route)
      return {
        calls: () => route.calls,
        received: async (count) => {
          while (route.calls.length < count) {
            await new Promise<void>((resolve) => waiting.push(resolve))
          }
          return route.calls
        },
      }
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
      closed = true
      for (const release of held.values()) release()
      await Effect.runPromise(Scope.close(scope, Exit.void))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
