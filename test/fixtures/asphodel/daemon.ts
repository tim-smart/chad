// Test support for the asphodel fixture. An HttpClient that plays the asphodel // adjusted: TIM-558
// daemon in memory and records every request. The response shapes follow
// crates/asphodel/src/serve/api.rs at f8ccdea. Nothing here is the daemon.
// The request bodies are typed `any`, which the repo's lint refuses. // adjusted: ASP-G8
/* oxlint-disable typescript/no-explicit-any */ // adjusted: ASP-G8
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

export interface Request {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly body: any
}

export const make = () => {
  const state = {
    up: true,
    requests: [] as Array<Request>,
    refused: 0,
    blocks: 0,
    recalls: 0,
  }

  const answer = (request: Request): [status: number, body: unknown] => {
    const route = `${request.method} ${request.path.replace(/^\/v1/, "").replace(/^\/banks\/[^/]+/, "/bank")}`
    if (route === "GET /health") return [200, { ready: true, version: "0.4.0" }]
    if (route === "PUT /bank") return [200, { name: "chad" }]
    if (route === "GET /bank/system-prompt") {
      const id = `block-${++state.blocks}`
      return [200, { id, text: `[asphodel agenda, ${id}]` }]
    }
    if (route === "POST /bank/prefetch") {
      const id = `recall-${++state.recalls}`
      return [
        200,
        {
          recall_id: id,
          text: `[memories for "${request.body.query}", ${id}]`,
          injected: ["m1"],
          reranked: true,
        },
      ]
    }
    if (route === "POST /bank/turns")
      return [
        200,
        { outcome: request.body.forget_requested ? "tombstone" : "stored" },
      ]
    if (route === "POST /bank/recall")
      return [
        200,
        { text: "m7: Tim's dentist is Dr. Lee", results: [{ id: "m7" }] },
      ]
    if (route === "POST /bank/forget")
      return [200, { forgotten: request.body.ids, unknown: [] }]
    if (route === "POST /bank/keep" || route === "POST /bank/unkeep")
      return [200, { ids: request.body.ids }]
    if (/^POST \/bank\/sessions\/[^/]+\/clear$/.test(route))
      return [204, undefined]
    return [404, { error: `no route ${route}` }]
  }

  const client = HttpClient.make((request, url) => {
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined
    const seen: Request = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    }
    if (!state.up) {
      state.refused++
      console.log(`  daemon  ${seen.method} ${seen.path} -> connection refused`)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "connection refused",
          }),
        }),
      )
    }
    state.requests.push(seen)
    const [status, json] = answer(seen)
    const query = Object.keys(seen.query).length
      ? `?${new URLSearchParams(seen.query)}`
      : ""
    console.log(
      `  daemon  ${seen.method} ${seen.path}${query} ${body === undefined ? "" : JSON.stringify(body)} -> ${status}`,
    )
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(json === undefined ? null : JSON.stringify(json), {
          status,
        }),
      ),
    )
  })

  return {
    client,
    state,
    /** The requests since the last call, as "METHOD route". */
    take: (): Array<Request> => state.requests.splice(0),
  }
}
