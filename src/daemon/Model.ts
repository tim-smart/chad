import * as ModelLayer from "clanka/ModelLayer"
import * as OpenAiCompat from "clanka/OpenAiCompat"
import { Layer, Option, Redacted } from "effect"
import type { Environment } from "./Environment.ts"

/**
 * The model layer for the setting in `CHAD_MODEL`, which is one value in clanka's format,
 * `<provider>/<model>[/<effort>]`. With `openai-compat` the endpoint and the key come from the environment and no
 * login is needed. Every request goes through the `HttpClient` the layer is given.
 */
export const layer = (environment: Environment) =>
  Option.fromNullishOr(environment.model).pipe(
    Option.flatMap(ModelLayer.parseModelSpec),
    Option.filter((spec) => spec.provider === "openai-compat"),
    Option.map((spec) =>
      OpenAiCompat.model(
        spec.model,
        spec.effort === undefined
          ? undefined
          : { reasoning: { effort: spec.effort } },
      ).pipe(
        Layer.provide(
          OpenAiCompat.layerClient({
            apiUrl: environment.openaiApiUrl,
            apiKey:
              environment.openaiApiKey === undefined
                ? undefined
                : Redacted.make(environment.openaiApiKey),
          }),
        ),
      ),
    ),
  )
