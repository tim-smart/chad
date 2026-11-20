// The HTTP client a daemon of a scenario gets, in the test's process or in the child process of layer 4.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Socket } from "effect/socket"
import * as Discord from "./discord.ts"

/**
 * The two Codex hosts and the two of Antigravity's sign-in and Cloud Code that clanka hardcodes, and where on the fake
 * model server each goes.
 */
export const codexHosts = (model: string) => {
  const origin = new URL(model).origin
  return [
    ["https://chatgpt.com/backend-api/codex", `${origin}/codex`],
    ["https://auth.openai.com", `${origin}/auth`],
    ["https://oauth2.googleapis.com", `${origin}/google`],
    ["https://daily-cloudcode-pa.googleapis.com", `${origin}/cloudcode`],
  ] as const
}

/** A URL with a Codex host rewritten to the fake model server, and any other URL as it is. */
export const rewrite = (
  url: string,
  rewrites: ReadonlyArray<readonly [string, string]>,
) => {
  const found = rewrites.find(([from]) => url.startsWith(from))
  return found === undefined ? url : found[1] + url.slice(found[0].length)
}

/**
 * A client that reaches the fakes and fails a request to any other host. A request to Discord's REST root goes to the
 * fake Discord REST server, and one to a Codex host to the fake model server. It notes every request by the URL the
 * daemon asked for.
 */
export const httpClient = (
  fakes: { readonly model: string; readonly discord: string },
  requests: Array<string> = [],
) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const hosts = [fakes.model, fakes.discord].map((url) => new URL(url).host)
      const rewrites = [
        [Discord.restRoot, fakes.discord] as const,
        ...codexHosts(fakes.model),
      ]
      // This runs on the request as it leaves, after the base URL a caller prepends.
      return HttpClient.make((request) => {
        requests.push(request.url)
        const sent = HttpClientRequest.setUrl(
          request,
          rewrite(request.url, rewrites),
        )
        return hosts.includes(new URL(sent.url).host)
          ? client.execute(sent)
          : Effect.die(
              new Error(
                `the daemon asked for ${request.url}, which is no fake`,
              ),
            )
      })
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici))

/** The URL clanka opens a Codex socket at, as `OpenAiClient` makes it from the HTTP one. */
const codexSocket = "wss://chatgpt.com/backend-api/codex"

/**
 * The WebSocket constructor a daemon of a scenario gets: a socket to Codex goes to the fake model server's socket, with
 * the headers of its opening request, as the product's constructor sends them. Any other goes to `other`.
 */
export const webSocketConstructor = (
  socket: string,
  other: Layer.Layer<Socket.WebSocketConstructor>,
) =>
  Layer.effect(
    Socket.WebSocketConstructor,
    Effect.gen(function* () {
      const fallback = yield* Socket.WebSocketConstructor
      const node = Context.get(
        yield* Layer.build(NodeSocket.layerWebSocketConstructor),
        Socket.WebSocketConstructor,
      )
      return (url, options) =>
        url.startsWith(codexSocket)
          ? node(socket + url.slice(codexSocket.length), options)
          : fallback(url, options)
    }),
  ).pipe(Layer.provide(other))
