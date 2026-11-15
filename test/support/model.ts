// The fake model server of docs/spec/17-testing.md, on its `openai-compat` side. It is an HTTP server that the test
// starts, scripted by call index, and a script can hold a response until the test releases it.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

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
}

/** A call the fake received. */
export interface Call {
  readonly index: number
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export interface FakeModel {
  /** The value for `CHAD_OPENAI_API_URL`. */
  readonly url: string
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

/** What a call carries as the results of the tools the model called before it, oldest first. */
export const results = (call: Call | undefined): ReadonlyArray<string> => {
  const body = call?.body as
    | { messages?: ReadonlyArray<{ role?: string; content?: unknown }> }
    | undefined
  return (body?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content))
}

export interface Options {
  /** The address and the port to listen on, in place of this machine's own address and a free port. */
  readonly host?: string
  readonly port?: number
  /** Called with each call as it arrives, for an event log. */
  readonly heard?: (call: Call) => void
}

/** Starts the fake. The image layer tells it where to listen, because its daemon is in another container. */
export const start = async (options: Options = {}): Promise<FakeModel> => {
  const host = options.host ?? "127.0.0.1"
  let replies: ReadonlyArray<Reply> = []
  let calls: Array<Call> = []
  const held = new Map<number, () => void>()
  const released = new Set<number>()
  const waiting: Array<() => void> = []

  const server = createServer((request, response) => {
    const parts: Array<Buffer> = []
    request.on("data", (part: Buffer) => parts.push(part))
    request.on("end", async () => {
      const index = calls.length
      const text = Buffer.concat(parts).toString("utf8")
      const call: Call = {
        index,
        path: request.url ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name,
            String(value),
          ]),
        ),
        body: text === "" ? null : JSON.parse(text),
      }
      calls.push(call)
      options.heard?.(call)
      for (const wake of waiting.splice(0)) wake()
      const reply = replies[index]
      if (reply === undefined) {
        response.writeHead(500, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            error: { message: `the script has no reply for call ${index}` },
          }),
        )
        return
      }
      if (reply.hold === true && !released.has(index)) {
        await new Promise<void>((resolve) => held.set(index, resolve))
      }
      if (reply.status !== undefined && reply.status !== 200) {
        response.writeHead(reply.status, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "scripted failure" } }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      // A tool call is one entry of the delta's `tool_calls`, with its arguments as JSON text, and it ends the
      // response with `tool_calls` where an answer ends it with `stop`.
      const { tool } = reply
      const events = [
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
        {
          ...chunk({}, null),
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      for (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      response.end("data: [DONE]\n\n")
    })
  })
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, host, resolve),
  )
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/v1`,
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
    close: () =>
      new Promise((resolve) => {
        for (const release of held.values()) release()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
