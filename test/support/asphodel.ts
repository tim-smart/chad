// The fake asphodel daemon over HTTP, for layer 4. A daemon that is killed cannot hold the in-memory fake, so it stays
// in the test's process and the child's plugin reaches it at this server's URL. Each request goes to the fake's
// HttpClient as it came, so the fake records it as it does in layer 3.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { HttpClientRequest, type HttpMethod } from "effect/http"
import { onTestFinished } from "vitest"
import type * as Daemon from "../fixtures/asphodel/daemon.ts"

/** Serves `fake` until the end of the test, and gives the URL a plugin's `url` setting takes. */
export const serve = async (fake: ReturnType<typeof Daemon.make>) => {
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Array<Buffer> = []
    for await (const chunk of incoming) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    let request = HttpClientRequest.make(
      incoming.method as HttpMethod.HttpMethod,
    )(`http://asphodel${incoming.url}`)
    if (body.length > 0)
      request = HttpClientRequest.bodyUint8Array(
        request,
        body,
        "application/json",
      )
    // A fake that is down refuses: the connection ends with no answer.
    const answer = await Effect.runPromise(
      fake.client.execute(request).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (text) => ({
            status: response.status,
            text,
          })),
        ),
        Effect.option,
      ),
    )
    if (answer._tag === "None") return void outgoing.destroy()
    outgoing.writeHead(answer.value.status, {
      "content-type": "application/json",
    })
    outgoing.end(answer.value.text)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
