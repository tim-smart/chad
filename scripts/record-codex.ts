/**
 * The recorder of the Codex frames (TST-43, TST-41). The builder runs it once, by hand, through the OpenAI endpoint and
 * key of its own environment, and no test and no job on the gate reads that key. docs/build/codex-capture.md is the
 * record of the run and says how to make it again:
 *
 *   nix develop -c node scripts/record-codex.ts [--model <model>] [--raw <file outside the repository>]
 *
 * It reads the endpoint from CLANKA_OPENAI_API_URL and the key from CLANKA_OPENAI_API_KEY. It makes one call that
 * answers over server-sent events (`POST <url>/responses`) and one over WebSocket (a `response.create` message on
 * `<url>/responses`), and writes test/unit/fixtures/codex-frames.json only through the stripper of
 * test/support/recording.ts. It writes nothing when the stripped result still holds the key, the endpoint, a part of
 * its host or a JWT, and then prints only where. Of what it was given or received it prints no more than how
 * each call ended: an event type, a status and an error code.
 */
import { writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import {
  hostParts,
  keep,
  leftover,
  load,
  path as fixture,
  type Recording,
} from "../test/support/recording.ts"

const root = join(import.meta.dirname, "..")

export interface Options {
  /** The endpoint, as in `CLANKA_OPENAI_API_URL`, which serves `/responses`. */
  readonly url: string
  readonly key: string
  readonly model: string
  /** Where the socket opens, in place of `<url>/responses` with a `ws` scheme. A test passes the fake's. */
  readonly socketUrl?: string
  /** Where the stripped recording goes. */
  readonly out: string
  /** Where the raw recording goes as well, which must be outside the repository. */
  readonly raw?: string
}

/** What a run did: whether it wrote, how each call ended, and where a secret was left when it refused to write. */
export interface Outcome {
  readonly written: boolean
  readonly calls: { readonly http: string; readonly socket: string }
  readonly leftover: ReadonlyArray<string>
}

/** The prompt of both calls, which says nothing about who made them. */
const instructions = "Answer in one short sentence."
const prompt = "Say hello."
const input = [
  { role: "user", content: [{ type: "input_text", text: prompt }] },
]

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The events of a server-sent event stream, each `data` as JSON. */
const sse = (text: string): Array<object> =>
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
    .map((data) => parsed(data) as object)

const typeOf = (event: unknown) =>
  typeof event === "object" && event !== null && "type" in event
    ? String(event.type)
    : undefined

/** How a call ended, naming no value of the service's but an event type, a status and an error code. */
const ending = (events: ReadonlyArray<object>, status?: number): string => {
  const last = events.at(-1)
  if (typeOf(last) === "response.completed") return "answered"
  const error = (last as { error?: { code?: unknown; type?: unknown } })?.error
  return [
    "not answered",
    status === undefined ? undefined : `status ${status}`,
    typeOf(last),
    typeof error?.code === "string" ? error.code : undefined,
    typeof error?.type === "string" ? error.type : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ")
}

const responses = (url: string) => `${url.replace(/\/+$/, "")}/responses`

/** One call over server-sent events. */
const overHttp = async (options: Options) => {
  const response = await fetch(responses(options.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.key}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: options.model,
      instructions,
      input,
      stream: true,
      store: false,
    }),
  })
  const text = await response.text()
  const events = response.ok ? sse(text) : [parsed(text) as object]
  return { events, outcome: ending(events, response.status) }
}

const ended = (type: string | undefined) =>
  type === "response.completed" ||
  type === "response.failed" ||
  type === "response.incomplete" ||
  type === "error"

/** One call over WebSocket: a `response.create` message, and every frame up to the one that ends the response. */
const overSocket = (options: Options) =>
  new Promise<{ events: Array<object>; outcome: string }>((resolve) => {
    const events: Array<object> = []
    const url =
      options.socketUrl ?? responses(options.url).replace(/^http/, "ws")
    // Node's WebSocket takes the opening request's headers as an option of its own.
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${options.key}` },
    } as unknown as string)
    const finish = (outcome: string) => {
      clearTimeout(timer)
      socket.close()
      resolve({ events, outcome })
    }
    const timer = setTimeout(() => finish("not answered, timed out"), 120_000)
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: options.model,
          instructions,
          input,
          store: false,
        }),
      ),
    )
    socket.addEventListener("message", (message) => {
      const event = parsed(String(message.data)) as object
      events.push(event)
      if (ended(typeOf(event))) finish(ending(events))
    })
    socket.addEventListener("error", () => finish("not answered, socket error"))
    socket.addEventListener("close", (event) =>
      finish(`not answered, closed ${event.code}`),
    )
  })

/** The fixture's `source` line. */
export const source =
  "The two answers are recorded, once, by scripts/record-codex.ts through an OpenAI endpoint that relays the Responses API (TST-43): `answer.http` is one call over server-sent events and `answer.socket` one call over WebSocket, as a `response.create` message to /v1/responses. They are what the proxy relays, which is not shown to be what chatgpt.com/backend-api/codex sends. The usage-limit frame under `refusal` is hand-made from the error schema clanka decodes (TST-41), and so is what a new connection gets while the limit is in force, which in the fake is a socket that opens and answers `response.create` with that frame."

/** The raw frames of the two calls, as `--raw` keeps them. */
export interface Raw {
  readonly http: ReadonlyArray<object>
  readonly socket: ReadonlyArray<object>
}

/**
 * The recording that may be kept, from the raw frames: stripped and renumbered, with the hand-made usage-limit frame
 * of the kept recording, and where it still holds a JWT, a secret field or one of `secrets`.
 */
export const assemble = (raw: Raw, secrets: ReadonlyArray<string>) => {
  const recording: Recording = {
    source,
    answer: { http: keep(raw.http), socket: keep(raw.socket) },
    refusal: load().refusal,
  }
  return { recording, leftover: leftover(recording, secrets) }
}

/** Records both calls and writes the stripped recording, or refuses to. */
export const record = async (options: Options): Promise<Outcome> => {
  if (
    options.raw !== undefined &&
    !relative(root, options.raw).startsWith("..")
  ) {
    throw new Error("--raw must name a file outside the repository")
  }
  const http = await overHttp(options)
  const socket = await overSocket(options)
  const calls = { http: http.outcome, socket: socket.outcome }
  if (options.raw !== undefined) {
    writeFileSync(
      options.raw,
      `${JSON.stringify({ http: http.events, socket: socket.events }, null, 2)}\n`,
    )
  }
  if (http.outcome !== "answered" || socket.outcome !== "answered") {
    return { written: false, calls, leftover: [] }
  }
  const { recording, leftover: left } = assemble(
    { http: http.events, socket: socket.events },
    [options.key, options.url, ...hostParts(options.url)],
  )
  if (left.length > 0) return { written: false, calls, leftover: left }
  writeFileSync(options.out, `${JSON.stringify(recording, null, 2)}\n`)
  return { written: true, calls, leftover: [] }
}

const flag = (name: string) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

if (import.meta.main) {
  const url = process.env["CLANKA_OPENAI_API_URL"]
  const key = process.env["CLANKA_OPENAI_API_KEY"]
  if (url === undefined || url === "" || key === undefined || key === "") {
    console.error(
      "CLANKA_OPENAI_API_URL and CLANKA_OPENAI_API_KEY must both be set",
    )
    process.exit(2)
  }
  const raw = flag("--raw")
  const outcome = await record({
    url,
    key,
    model: flag("--model") ?? "gpt-6-astra",
    out: fixture,
    ...(raw === undefined ? {} : { raw }),
  })
  console.log(JSON.stringify(outcome, null, 2))
  process.exit(outcome.written ? 0 : 1)
}
