// Test support for the bundled asphodel plugin. An HttpClient that plays the asphodel daemon in memory and records
// every request. The answers have the shapes of crates/asphodel/src/serve/api.rs in tim-smart/asphodel at f8ccdea, as
// a real daemon gave them with no LLM set. Nothing here is the daemon. The request bodies are typed `any`, which the
// repo's lint refuses.
/* oxlint-disable typescript/no-explicit-any */
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

export interface Request {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly body: any
  /** The request's Authorization header, when it has one. */
  readonly authorization?: string | undefined
}

export const make = () => {
  const state = {
    up: true,
    requests: [] as Array<Request>,
    refused: 0,
    /** Routes, as "POST /bank/turns", that answer 200 with a body that matches none of the daemon's answers. */
    invalid: new Set<string>(),
    bank: false,
    blocks: 0,
    recalls: 0,
  }

  const answer = (request: Request): [status: number, body: unknown] => {
    const route = `${request.method} ${request.path.replace(/^\/v1/, "").replace(/^\/banks\/[^/]+/, "/bank")}`
    const now = new Date().toISOString()
    if (state.invalid.has(route)) return [200, {}]
    if (route === "GET /health")
      return [200, { version: "0.1.0", ready: true, setup: false, now }]
    if (route === "PUT /bank") {
      const created = !state.bank
      state.bank = true
      return [
        created ? 201 : 200,
        {
          id: "bank-1",
          name: "chad",
          owner_name: request.body.owner_name,
          assistant_name: request.body.assistant_name,
          timezone: request.body.timezone,
          embedding_model: "embedding",
          reranker_model: "reranker",
          created,
        },
      ]
    }
    if (route === "GET /bank/system-prompt") {
      const id = `block-${++state.blocks}`
      return [
        200,
        {
          id,
          built_at: now,
          text: `[asphodel agenda, ${id}]`,
          agenda: [],
          cited: [],
        },
      ]
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
    if (route === "POST /bank/turns") {
      const tombstone = request.body.forget_requested === true
      return [
        200,
        {
          source: `source-${state.requests.length}`,
          outcome: tombstone ? "tombstone" : "stored",
          chunks_queued: tombstone ? 0 : 1,
          chunks_skipped: 0,
          secret_kinds: [],
          speaker: tombstone ? null : { entity: "user", owner: true },
        },
      ]
    }
    if (route === "POST /bank/recall")
      return [
        200,
        {
          recall_id: `recall-${++state.recalls}`,
          results: [{ id: "m7" }],
          text: "m7: Tim's dentist is Dr. Lee",
          reranked: true,
        },
      ]
    if (route === "POST /bank/forget")
      return [200, { forgotten: request.body.ids, unknown: [] }]
    if (route === "POST /bank/keep")
      return [200, { kept: request.body.ids, unknown: [] }]
    if (route === "POST /bank/unkeep")
      return [200, { unkept: request.body.ids, unknown: [] }]
    if (/^POST \/bank\/sessions\/[^/]+\/clear$/.test(route))
      return [204, undefined]
    return [404, { error: "no such route" }]
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
      authorization: request.headers["authorization"],
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
