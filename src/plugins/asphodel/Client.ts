// The asphodel daemon's HTTP interface as the plugin uses it: one request with its timeout, the breaker in front of
// every request, and the answers the plugin reads, each decoded with Schema. Only `http:` and `https:` URLs work,
// because they are what an HttpClient speaks.
import {
  Clock,
  Data,
  type Duration,
  Effect,
  Option,
  Redacted,
  Schema,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

/** The daemon could not be reached, timed out, or the breaker is open. */
export class DaemonUnavailable extends Data.TaggedError("DaemonUnavailable")<{
  readonly reason: string
}> {}

/** The daemon answered with a status outside 2xx. */
export class DaemonError extends Data.TaggedError("DaemonError")<{
  readonly status: number
  readonly message: string
}> {}

/** The daemon answered 2xx with an answer that does not decode. */
export class DaemonInvalid extends Data.TaggedError("DaemonInvalid")<{
  readonly status: number
  readonly message: string
}> {}

export type DaemonFailure = DaemonUnavailable | DaemonError | DaemonInvalid

/**
 * Whether the daemon refused a request for good, which only a 4xx says. A turn whose ingest failed any other way, with
 * no answer, a 5xx or an answer that does not decode, is kept to send again.
 */
export const refused = (failure: DaemonFailure): failure is DaemonError =>
  failure._tag === "DaemonError" && failure.status < 500

/** Failures in a row that open the breaker, and how long it stays open before the next request is tried. */
const breakerFailures = 3
const breakerCooldownMillis = 30_000

// The answers the plugin reads. The daemon's answers carry more keys than these, and a decode ignores them.

/** `GET /v1/health`. A daemon that is starting answers 503 with `ready: false`. */
export const Health = Schema.Struct({
  ready: Schema.Boolean,
  version: Schema.String,
})

/** `PUT /v1/banks/{bank}`, 201 when it made the bank and 200 when it already had it. */
export const Bank = Schema.Struct({ name: Schema.String })

/** `GET /v1/banks/{bank}/system-prompt`: the block for a session's system prompt. */
export const Block = Schema.Struct({ text: Schema.String })

/** `POST /v1/banks/{bank}/prefetch`: the memories for one message, empty when none passed, and the id to echo. */
export const Prefetch = Schema.Struct({
  recall_id: Schema.String,
  text: Schema.String,
})

/** `POST /v1/banks/{bank}/recall`: what `memory_recall` found, as lines with their memory ids. */
export const Recall = Schema.Struct({ text: Schema.String })

/** `POST /v1/banks/{bank}/turns`. */
export const Ingested = Schema.Struct({
  outcome: Schema.Literals(["stored", "duplicate", "tombstone"]),
})

const ids = Schema.Array(Schema.String)

/** `POST /v1/banks/{bank}/forget`: every id the erase removes, and the ids that named no memory. */
export const Forgotten = Schema.Struct({ forgotten: ids, unknown: ids })

/** `POST /v1/banks/{bank}/keep`. */
export const Kept = Schema.Struct({ kept: ids, unknown: ids })

/** `POST /v1/banks/{bank}/unkeep`. */
export const Unkept = Schema.Struct({ unkept: ids, unknown: ids })

/** `POST /v1/banks/{bank}/sessions/{id}/clear` answers 204 with no body, so nothing is read. */
export const NoContent = Schema.Unknown

/** The body of an answer outside 2xx. */
const ErrorBody = Schema.Struct({ error: Schema.String })
const errorOf = Schema.decodeUnknownOption(ErrorBody)

/** An answer schema: one that decodes from what `JSON.parse` gives and needs no service. */
export type Answer<A> = Schema.Codec<A, unknown>

export interface Options {
  readonly body?: unknown
  readonly query?: Record<string, string>
  readonly timeout: Duration.Input
}

export type Method = "GET" | "POST" | "PUT"

/** The client of one daemon at `url`. Its breaker is shared by every request it sends. */
export const make = Effect.fnUntraced(function* (config: {
  readonly url: string
  readonly token: Option.Option<Redacted.Redacted>
}) {
  const http = yield* HttpClient.HttpClient
  let failures = 0
  let openedAt: number | undefined

  /**
   * One request and its status and JSON, `undefined` when the body is not JSON. A failure to connect, a timeout and an
   * open breaker are each `DaemonUnavailable`. A request that gets any answer closes the breaker, and three failures in
   * a row open it for 30 seconds.
   */
  const request = (
    method: Method,
    path: string,
    options: Options,
  ): Effect.Effect<
    { readonly status: number; readonly json: unknown },
    DaemonUnavailable
  > =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      if (openedAt !== undefined && now - openedAt < breakerCooldownMillis) {
        return yield* new DaemonUnavailable({ reason: "circuit breaker open" })
      }
      let req = HttpClientRequest.make(method)(`${config.url}/v1${path}`).pipe(
        HttpClientRequest.acceptJson,
      )
      if (options.query)
        req = HttpClientRequest.setUrlParams(req, options.query)
      if (options.body !== undefined)
        req = HttpClientRequest.bodyJsonUnsafe(req, options.body)
      if (Option.isSome(config.token))
        req = HttpClientRequest.bearerToken(
          req,
          Redacted.value(config.token.value),
        )
      return yield* http.execute(req).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.map((json) => ({ status: response.status, json })),
          ),
        ),
        Effect.timeoutOrElse({
          duration: options.timeout,
          orElse: () =>
            Effect.fail(new DaemonUnavailable({ reason: "timed out" })),
        }),
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(new DaemonUnavailable({ reason: error.reason._tag })),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            failures = 0
            openedAt = undefined
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            if (++failures >= breakerFailures) openedAt = now
          }),
        ),
      )
    })

  /**
   * A request whose answer has to be 2xx and decode with `answer`. Any other status is a `DaemonError` with the
   * daemon's `error` text, and an answer that does not decode is a `DaemonInvalid` with its status.
   */
  const ok = <A>(
    method: Method,
    path: string,
    answer: Answer<A>,
    options: Options,
  ): Effect.Effect<A, DaemonFailure> =>
    Effect.flatMap(
      request(method, path, options),
      ({ status, json }): Effect.Effect<A, DaemonFailure> =>
        status >= 200 && status < 300
          ? Schema.decodeUnknownEffect(answer)(json).pipe(
              Effect.mapError(
                (error) =>
                  new DaemonInvalid({
                    status,
                    message: `the answer did not decode: ${error.message}`,
                  }),
              ),
            )
          : Effect.fail(
              new DaemonError({
                status,
                message: Option.match(errorOf(json), {
                  onNone: () => "",
                  onSome: ({ error }) => error,
                }),
              }),
            ),
    )

  return { request, ok }
})
