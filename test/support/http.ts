// The HTTP client a daemon of a scenario gets, in the test's process or in the child process of layer 4.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as Discord from "./discord.ts"

/**
 * A client that reaches the fakes and fails a request to any other host. A request to Discord's REST root goes to the
 * fake Discord REST server. It notes every request by the URL the daemon asked for.
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
      // This runs on the request as it leaves, after the base URL a caller prepends.
      return HttpClient.make((request) => {
        requests.push(request.url)
        const sent = request.url.startsWith(Discord.restRoot)
          ? HttpClientRequest.setUrl(
              request,
              fakes.discord + request.url.slice(Discord.restRoot.length),
            )
          : request
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
