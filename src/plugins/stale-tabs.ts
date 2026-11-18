// The bundled plugin `stale-tabs`: closes the tabs of a shared Chromium that have sat on one URL for too long. Every
// few minutes it lists the browser's pages through the DevTools HTTP endpoint, notes in its store when each page's URL
// last changed, and closes each page whose URL has not changed for longer than `maxAge`. It always leaves one page
// open. It is off until `chad.json` turns it on with `"enabled": true` and the DevTools `url`.
//
// It cannot tell chad's tabs from the owner's, because the browser does not record who opened a tab, so the age of a
// tab's URL is all it goes by. It speaks plain HTTP to DevTools and never runs `agent-browser`, so it works with any
// version of it and leaves a session's agent-browser daemon alone.
import {
  Clock,
  Config,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { KeyValueStore } from "effect/persistence"
import * as Plugin from "../Plugin.ts"

/** How often the browser is swept. */
const sweepEvery = "5 minutes"
/** How long one DevTools request may take. */
const requestTimeout = "5 seconds"

/** One entry of `GET /json/list`. Its other keys are ignored. */
const Target = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  url: Schema.String,
})
const Targets = Schema.Array(Target)

/** What the store keeps for a page: its URL and when the plugin first saw it there, in epoch millis. */
const Seen = Schema.Struct({ url: Schema.String, since: Schema.Number })
const SeenJson = Schema.fromJsonString(Seen)
const decodeSeen = Schema.decodeUnknownOption(SeenJson)
const encodeSeen = Schema.encodeSync(SeenJson)

// The settings are read when the plugin loads, so a missing `url` fails the load and not the fiber.
const sweeper = Effect.gen(function* () {
  const { name, store } = yield* Plugin.PluginContext
  const config = yield* Config.all({
    url: Config.String("url"),
    maxAge: Config.Duration("maxAge").pipe(
      Config.withDefault(Duration.hours(12)),
    ),
  })
  const base = config.url.replace(/\/+$/, "")
  const maxAgeMillis = Duration.toMillis(config.maxAge)
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
  const seen = KeyValueStore.prefix(store, "tab/")
  // Whether the last sweep reached the browser, so a browser that is down is logged once and not every sweep.
  let reachable = true

  /** The browser's pages, or nothing when it does not answer. */
  const pages = Effect.gen(function* () {
    const listed = yield* http
      .get(`${base}/json/list`)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Targets)),
        Effect.timeout(requestTimeout),
        Effect.result,
      )
    if (listed._tag === "Failure") {
      if (reachable) {
        yield* Effect.logWarning(
          `${name}: the browser at ${base} does not answer, so no tab is closed until it does`,
          listed.failure,
        )
      }
      reachable = false
      return Option.none()
    }
    if (!reachable) yield* Effect.logInfo(`${name}: the browser answers again`)
    reachable = true
    return Option.some(
      listed.success.filter((target) => target.type === "page"),
    )
  })

  /**
   * Closes one page. Chromium answers 404 for a page that is already gone, which counts as closed. Any other failure
   * leaves the page for the next sweep.
   */
  const close = (id: string) =>
    http.get(`${base}/json/close/${encodeURIComponent(id)}`).pipe(
      Effect.timeout(requestTimeout),
      Effect.as(true),
      Effect.catch((error) =>
        error._tag === "HttpClientError" && error.response?.status === 404
          ? Effect.succeed(true)
          : Effect.as(
              Effect.logWarning(`${name}: could not close a tab`, error),
              false,
            ),
      ),
    )

  const sweep = Effect.gen(function* () {
    const listed = yield* pages
    if (Option.isNone(listed)) return
    const now = yield* Clock.currentTimeMillis
    const open = new Set(listed.value.map((page) => page.id))

    // A page the store does not know, or one whose URL changed, starts its age now.
    const stale: Array<{ readonly id: string; readonly since: number }> = []
    for (const page of listed.value) {
      const known = Option.flatMap(
        Option.fromUndefinedOr(yield* seen.get(page.id)),
        decodeSeen,
      )
      if (Option.isNone(known) || known.value.url !== page.url) {
        yield* seen.set(page.id, encodeSeen({ url: page.url, since: now }))
      } else if (now - known.value.since > maxAgeMillis) {
        stale.push({ id: page.id, since: known.value.since })
      }
    }

    // The store has no expiry, so the plugin forgets each page that is gone.
    for (const key of yield* seen.keys) {
      if (!open.has(key)) yield* seen.remove(key)
    }

    // One page always stays: with none left, the deploy's Chromium restarts. When every page is stale, the one whose
    // URL changed last is kept.
    const closing =
      stale.length === open.size
        ? stale.toSorted((a, b) => b.since - a.since).slice(1)
        : stale
    let closed = 0
    for (const { id } of closing) {
      if (yield* close(id)) {
        yield* seen.remove(id)
        closed++
      }
    }
    if (closed > 0) {
      yield* Effect.logInfo(
        `${name}: closed ${closed} ${closed === 1 ? "tab" : "tabs"} unchanged for more than ${Duration.format(config.maxAge)}`,
      )
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`${name}: the sweep failed`, error),
    ),
  )

  return { sweep }
})

// The first sweep runs when chad activates the plugin and the next every five minutes. Unloading the plugin
// interrupts the fiber.
export default Plugin.make(
  Layer.unwrap(
    Effect.map(sweeper, ({ sweep }) =>
      Plugin.background(sweep.pipe(Effect.repeat(Schedule.spaced(sweepEvery)))),
    ),
  ),
)
