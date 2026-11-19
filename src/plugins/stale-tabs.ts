// The bundled plugin `stale-tabs`: closes the tabs of a shared Chromium that have sat on one URL for too long. Every
// few minutes it lists the browser's pages through the DevTools HTTP endpoint, notes in its store when each page's URL
// last changed, and closes each page whose URL has not changed for longer than `maxAge`. It keeps one page open,
// because the deploy's Chromium restarts when its last page closes. It is off until `chad.json` turns it on with
// `"enabled": true` and the DevTools `url`.
//
// A close is a separate request from the list it was decided on, and the owner shares the browser, so the plugin
// lists the pages again before each close and closes a page only while it is on the same URL and another page that is
// not closing stays open. A page it sent a close to is closing until its id is gone from the list, whatever URL it
// shows meanwhile. That narrows the race and does not remove it: an owner who closes that other page between
// the list and the close still leaves no page, and Chromium restarts.
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

/**
 * What the store keeps for a page: its URL, when the plugin first saw it there, in epoch millis, and whether a close
 * was sent for it. Chromium answers a close before the page is gone, a close that timed out may have worked, and a
 * close names the page and not its URL, so a page with a close sent never counts as the one left open until a list
 * shows its id gone, whatever URL it is on meanwhile. It is sent the close again only once its URL is past `maxAge`,
 * as for a first close.
 */
const Seen = Schema.Struct({
  url: Schema.String,
  since: Schema.Number,
  closing: Schema.optionalKey(Schema.Boolean),
})
type Seen = typeof Seen.Type
const SeenJson = Schema.fromJsonString(Seen)
const decodeSeen = Schema.decodeUnknownOption(SeenJson)
const encodeSeen = Schema.encodeSync(SeenJson)

// The settings are read when the plugin loads, so a missing `url` fails the load and not the fiber.
const sweeper = Effect.gen(function* () {
  const { name, store } = yield* Plugin.PluginContext
  const config = yield* Config.all({
    url: Config.String("url"),
    maxAge: Config.Duration("maxAge").pipe(
      Config.withDefault(Duration.hours(1)),
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

  /** Closes one page, and gives whether Chromium took the close. A 404 is a page that is already gone. */
  const close = (id: string) =>
    http.get(`${base}/json/close/${encodeURIComponent(id)}`).pipe(
      Effect.timeout(requestTimeout),
      Effect.as("closing" as const),
      Effect.catch((error) =>
        error._tag === "HttpClientError" && error.response?.status === 404
          ? Effect.succeed("gone" as const)
          : Effect.as(
              Effect.logWarning(`${name}: could not close a tab`, error),
              "unknown" as const,
            ),
      ),
    )

  /**
   * Records what one list of the pages shows, and gives each page's record. A page the store does not know, or one
   * whose URL changed, starts its age now. A URL that changed keeps the mark of a close already sent, since the close
   * was for the page and may still be under way. Every list goes through here, so a URL change that only the list
   * before a close sees is kept too.
   */
  const observe = Effect.fnUntraced(function* (
    listed: ReadonlyArray<typeof Target.Type>,
  ) {
    const now = yield* Clock.currentTimeMillis
    const records = new Map<string, Seen>()
    for (const page of listed) {
      const known = Option.getOrUndefined(
        Option.flatMap(
          Option.fromUndefinedOr(yield* seen.get(page.id)),
          decodeSeen,
        ),
      )
      const record: Seen =
        known === undefined
          ? { url: page.url, since: now }
          : known.url === page.url
            ? known
            : { ...known, url: page.url, since: now }
      if (record !== known) yield* seen.set(page.id, encodeSeen(record))
      records.set(page.id, record)
    }
    return { now, records }
  })

  const sweep = Effect.gen(function* () {
    const listed = yield* pages
    if (Option.isNone(listed)) return
    const { now, records } = yield* observe(listed.value)

    // The store has no expiry, so the plugin forgets each page that is gone.
    for (const key of yield* seen.keys) {
      if (!records.has(key)) yield* seen.remove(key)
    }

    type Known = Seen & { readonly id: string }
    const stale: Array<Known> = []
    const retries: Array<Known> = []
    let live = 0
    for (const [id, record] of records) {
      const old = now - record.since > maxAgeMillis
      if (record.closing === true) {
        if (old) retries.push({ ...record, id })
      } else {
        live++
        if (old) stale.push({ ...record, id })
      }
    }

    // When every page that is not closing is stale, the one whose URL changed last is kept.
    const candidates = [
      ...retries,
      ...(stale.length === live
        ? stale.toSorted((a, b) => b.since - a.since).slice(1)
        : stale),
    ]
    let closed = 0
    for (const candidate of candidates) {
      // The browser as it is now. A list that fails ends the sweep, and a page that is gone or on another URL is
      // left to the next sweep.
      const current = yield* pages
      if (Option.isNone(current)) break
      const { records } = yield* observe(current.value)
      const record = records.get(candidate.id)
      if (
        record === undefined ||
        record.url !== candidate.url ||
        record.since !== candidate.since
      ) {
        continue
      }
      const others = [...records].some(
        ([id, other]) => id !== candidate.id && other.closing !== true,
      )
      if (!others) break
      // The mark goes in before the request, so a close that times out, or a chad killed mid-request, leaves it.
      yield* seen.set(candidate.id, encodeSeen({ ...record, closing: true }))
      const outcome = yield* close(candidate.id)
      if (outcome === "gone") yield* seen.remove(candidate.id)
      if (outcome === "closing") closed++
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
