// PROTOTYPE for TIM-530. Throwaway example: one plugin that contributes a
// tool and a prompt chunk, runs a background fiber and uses Effect's HttpClient.
import { Plugin } from "chad"
import { Tool, Toolkit } from "effect/ai"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

const Forecast = Schema.Struct({
  daily: Schema.Struct({
    time: Schema.Array(Schema.String),
    temperature_2m_max: Schema.Array(Schema.Finite),
    precipitation_sum: Schema.Array(Schema.Finite)
  })
})

// The plugin's own service. It holds the client and the background fiber, and
// it lives until the plugin is unloaded.
class Forecasts extends Context.Service<Forecasts>()("weather/Forecasts", {
  make: Effect.gen(function*() {
    const config = yield* Config.all({
      latitude: Config.Finite("latitude"),
      longitude: Config.Finite("longitude")
    })

    // The host's HttpClient, narrowed to this API.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl("https://api.open-meteo.com/v1")),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ times: 2 })
    )
    const forecast = (days: number) =>
      client.get("/forecast", {
        urlParams: {
          latitude: config.latitude,
          longitude: config.longitude,
          daily: "temperature_2m_max,precipitation_sum",
          forecast_days: days
        }
      }).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Forecast)))

    const today = yield* Ref.make("")
    yield* forecast(1).pipe(
      Effect.flatMap(({ daily }) =>
        Ref.set(today, `Today's weather: high ${daily.temperature_2m_max[0]}°C, rain ${daily.precipitation_sum[0]}mm.`)
      ),
      Effect.catch((error) => Effect.logWarning("weather: refresh failed", error)),
      Effect.repeat(Schedule.spaced("30 minutes")),
      Effect.forkScoped
    )

    return { forecast, today: Ref.get(today) }
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}

// Contribution 1: a tool.
const Weather = Toolkit.make(
  Tool.make("weatherForecast", {
    description: "The daily forecast for the owner's location, up to 16 days ahead.",
    parameters: Schema.Struct({ days: Schema.Int }),
    success: Forecast,
    failure: Schema.String
  })
)

const WeatherTools = Plugin.toolkit(Weather).pipe(
  Layer.provide(Weather.toLayer(Effect.gen(function*() {
    const forecasts = yield* Forecasts
    return Weather.of({
      weatherForecast: ({ days }) => forecasts.forecast(days).pipe(Effect.mapError((error) => error.message))
    })
  }))),
  Layer.provide(Forecasts.layer)
)

// Contribution 2: a prompt chunk, read from what the fiber last fetched.
const TodayChunk = Plugin.prompt(() => Effect.flatMap(Forecasts, (forecasts) => forecasts.today)).pipe(
  Layer.provide(Forecasts.layer)
)

// Both Layers provide `Forecasts.layer`. A Layer is built once per plugin
// load, so they share one client and one fiber.
export default Plugin.make(WeatherTools, TodayChunk)
