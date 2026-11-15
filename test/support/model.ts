// The fake model server of docs/spec/17-testing.md, on its `openai-compat` side. It is an HTTP server that the test
// starts, scripted by call index, and a script can hold a response until the test releases it.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

/** What the fake answers to one call. */
export interface Reply {
  /** The answer's text, sent as one streamed chunk. */
  readonly text?: string
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

export const start = async (): Promise<FakeModel> => {
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
      calls.push({
        index,
        path: request.url ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name,
            String(value),
          ]),
        ),
        body: text === "" ? null : JSON.parse(text),
      })
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
      const events = [
        chunk({ role: "assistant", content: reply.text ?? "" }, null),
        chunk({}, "stop"),
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
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
