// A test fixture for chad's plugin API. asphodel's Hermes plugin (`plugin/` in // adjusted: TIM-558
// tim-smart/asphodel at f8ccdea) written against chad's plugin API. It is not
// the port, which belongs to asphodel's repo, and it is not in the image. It // adjusted: TIM-558
// shows where each Hermes extension point lands and what the API has to // adjusted: TIM-558
// supply. Comments that start "Hermes:" name the part of the Python plugin a // adjusted: TIM-558
// block replaces. // adjusted: TIM-558
// The prototype's JSON reads are typed `any`, which the repo's lint refuses. // adjusted: ASP-G8
/* oxlint-disable typescript/no-explicit-any */ // adjusted: ASP-G8
import { Plugin, Session } from "chad"
import { Tool, Toolkit } from "effect/ai"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"

/** The daemon could not be reached, timed out, or the breaker is open. */
class DaemonUnavailable extends Data.TaggedError("DaemonUnavailable")<{
  readonly reason: string
}> {}
/** The daemon answered with a status outside 2xx. */
class DaemonError extends Data.TaggedError("DaemonError")<{
  readonly status: number
  readonly message: string
}> {}
type DaemonFailure = DaemonUnavailable | DaemonError

const DAEMON_MAJOR_VERSION = "0"
const BREAKER_FAILURES = 3
const BREAKER_COOLDOWN_MS = 30_000
const RERANK_CONTEXT_CHARS = 300
const MAX_IDS = 50
const SPOOL_MAX_TURNS = 500
const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// -- the plugin's own service ---------------------------------------------------
// Hermes builds one provider per session. chad builds this once per plugin
// load and it serves every session, so what Hermes kept on `self` is keyed by
// session id or turn id here.

class Asphodel extends Context.Service<Asphodel>()("asphodel/Asphodel", {
  make: Effect.gen(function* () {
    const { name, store, owners } = yield* Plugin.PluginContext

    // Hermes: get_config_schema, save_config and config.json. The values are // adjusted: TIM-548
    // this plugin's `settings` object in chad.json. The token is written // adjusted: TIM-548
    // `${ASPHODEL_TOKEN}` there and chad expands it before this read. // adjusted: TIM-548
    const config = yield* Config.all({
      url: Config.String("url").pipe(
        Config.withDefault("http://127.0.0.1:7720"),
      ),
      token: Config.option(Config.Redacted("token")),
      bank: Config.String("bank").pipe(Config.withDefault("chad")),
      ownerName: Config.option(Config.String("ownerName")),
      assistantName: Config.String("assistantName").pipe(
        Config.withDefault("chad"),
      ),
      timezone: Config.option(Config.String("timezone")),
      ingest: Config.Boolean("ingest").pipe(Config.withDefault(true)),
    })
    // Hermes: hermes_time.get_timezone_name(), then the configured default.
    const timezone =
      Option.getOrElse(config.timezone, () => "") ||
      DateTime.zoneToString(yield* DateTime.CurrentTimeZone)

    // Hermes: client.py and breaker.py. `unix:/path` URLs are not carried
    // over, because the host's HttpClient speaks http and https only.
    const http = yield* HttpClient.HttpClient
    let failures = 0
    let openedAt: number | undefined
    const request = (
      method: "GET" | "POST" | "PUT",
      path: string,
      options: {
        readonly body?: unknown
        readonly query?: Record<string, string>
        readonly timeout: Duration.Input
      },
    ): Effect.Effect<
      { readonly status: number; readonly json: any },
      DaemonUnavailable
    > =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (openedAt !== undefined && now - openedAt < BREAKER_COOLDOWN_MS) {
          return yield* new DaemonUnavailable({
            reason: "circuit breaker open",
          })
        }
        let req = HttpClientRequest.make(method)(
          `${config.url}/v1${path}`,
        ).pipe(HttpClientRequest.acceptJson)
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
              Effect.catch(() => Effect.succeed(undefined)),
              Effect.map((json) => ({
                status: response.status,
                json: json as any,
              })),
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
              if (++failures >= BREAKER_FAILURES) openedAt = now
            }),
          ),
        )
      })
    const ok = (
      method: "GET" | "POST" | "PUT",
      path: string,
      options: {
        readonly body?: unknown
        readonly query?: Record<string, string>
        readonly timeout: Duration.Input
      },
    ): Effect.Effect<any, DaemonFailure> =>
      Effect.flatMap(request(method, path, options), ({ status, json }) =>
        status >= 200 && status < 300
          ? Effect.succeed(json)
          : Effect.fail(
              new DaemonError({ status, message: String(json?.error ?? "") }),
            ),
      )

    // Hermes: _ensure_bank. Every bank operation retries the PUT until one works.
    const bankPath = `/banks/${encodeURIComponent(config.bank)}`
    let bankReady = false
    const ensureBank = (
      timeout: Duration.Input,
    ): Effect.Effect<void, DaemonFailure> =>
      bankReady
        ? Effect.void
        : ok("PUT", bankPath, {
            timeout,
            body: {
              owner_name: Option.getOrNull(config.ownerName),
              owner_platform_ids: owners,
              assistant_name: config.assistantName,
              timezone,
            },
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                bankReady = true
              }),
            ),
            Effect.asVoid,
          )
    const bank = (
      method: "GET" | "POST",
      path: string,
      options: {
        readonly body?: unknown
        readonly query?: Record<string, string>
        readonly timeout: Duration.Input
      },
    ) =>
      Effect.andThen(
        ensureBank(options.timeout),
        ok(method, bankPath + path, options),
      )

    // Hermes: initialize. A health probe and the bank PUT. A daemon that is
    // down must not fail the load. Hermes shows these warnings to the user
    // through `warning_callback`. chad has no such channel, so they are logs.
    yield* request("GET", "/health", { timeout: "2 seconds" }).pipe(
      Effect.tap(({ status, json }) => {
        const version =
          typeof json?.version === "string" ? json.version : undefined
        if (status !== 200 || !json?.ready)
          return Effect.logWarning(
            `${name}: the daemon isn't ready yet (status ${status})`,
          )
        if (version && version.split(".")[0] !== DAEMON_MAJOR_VERSION) {
          return Effect.logWarning(
            `${name}: the daemon is ${version}, this plugin was written for ${DAEMON_MAJOR_VERSION}.x`,
          )
        }
        return Effect.void
      }),
      Effect.andThen(ensureBank("2 seconds")),
      Effect.catch((error) =>
        Effect.logWarning(
          `${name}: memory is off until the daemon is back (${error._tag})`,
        ),
      ),
    )

    // Hermes: spool.py. One entry per turn the daemon did not take, in the
    // plugin's key-value store. The key sorts oldest first.
    const spool = KeyValueStore.prefix(store, "spool/")
    const spoolTurn = (turn: Session.Turn, body: unknown) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* spool.set(
          `${String(now).padStart(15, "0")}-${turn.id}`,
          JSON.stringify(body),
        )
        const keys = [...(yield* spool.keys)].sort()
        const stale = keys.filter(
          (key, index) =>
            Number(key.slice(0, 15)) < now - SPOOL_MAX_AGE_MS ||
            index < keys.length - SPOOL_MAX_TURNS,
        )
        yield* Effect.forEach(stale, (key) => spool.remove(key), {
          discard: true,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`${name}: could not spool a turn`, error),
        ),
      )
    // A 4xx drops the entry. A 5xx or no answer stops the replay and keeps the rest.
    const replaySpool: Effect.Effect<void> = Effect.gen(function* () {
      for (const key of [...(yield* spool.keys)].sort()) {
        const body = yield* spool.get(key)
        if (body !== undefined) {
          const sent = yield* bank("POST", "/turns", {
            body: JSON.parse(body),
            timeout: "10 seconds",
          }).pipe(Effect.result)
          if (
            sent._tag === "Failure" &&
            (sent.failure._tag === "DaemonUnavailable" ||
              sent.failure.status >= 500)
          )
            return
        }
        yield* spool.remove(key)
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`${name}: spool replay failed`, error),
      ),
    )
    // Hermes: shutdown. Nothing to drain. The scope closes the fiber.
    yield* Effect.addFinalizer(() => Effect.logInfo(`${name}: unloaded`))

    // Hermes: is_owner. With a turn id to hand, "a cron run is never the
    // owner" is "the turn did not start from a message". A sub-agent cannot
    // be told apart from the main agent, which is accepted. // adjusted: TIM-539
    // An id on the owner list is an owner whether or not it is a bot. // adjusted: TIM-559
    const isOwnerTurn = (turn: Option.Option<Session.Turn>): boolean => {
      if (Option.isNone(turn) || turn.value.origin._tag !== "Message")
        return false
      const { author } = turn.value.origin.message
      return owners.includes(
        `${turn.value.session.thread.platform}:${author.id}`,
      ) // adjusted: TIM-559
    }

    return {
      name,
      config,
      timezone,
      bank,
      spoolTurn,
      replaySpool,
      isOwnerTurn,
      /**
       * The system prompt block each session was given, by session id. Kept in
       * the store so a restart or a reload of the plugin does not fetch a
       * second block for a session that already has one.
       */
      blocks: KeyValueStore.prefix(store, "block/"),
      /** The last prefetch of each session, for previous_query and previous_reply. */
      last: new Map<
        string,
        { readonly turnId: string; readonly query: string; reply?: string }
      >(),
      /**
       * Turns in which memory_forget succeeded, by turn id. Hermes: the tool-call
       * scan in turns.py. Kept in the store so a reload of the plugin between
       * the tool call and afterTurn does not lose the mark.
       */ // adjusted: TIM-559
      forgets: KeyValueStore.prefix(store, "forget/"), // adjusted: TIM-559
      /** recall ids waiting for their turn to end, by turn id. Kept in the store so a resumed turn finds its own. */
      recalls: KeyValueStore.prefix(store, "recall/"),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

// -- the four tools (Hermes: tools.py and handle_tool_call) ---------------------

const Ids = Schema.Struct({ ids: Schema.Array(Schema.String) })
const ownerOnlyTool = <const Name extends string>(
  name: Name,
  description: string,
) =>
  Tool.make(name, {
    description: `${description} Only the owner may call it. Get ids from memory_recall; injected memories carry no ids.`,
    parameters: Ids,
    success: Schema.Json,
    failure: Schema.String,
    dependencies: [Session.CurrentSession],
  })

const Memory = Toolkit.make(
  Tool.make("memory_recall", {
    description:
      "Search Asphodel's long-term memory for what the user has said or done. " +
      "Use it for anything from an earlier conversation, and with phase 'upcoming' for what is coming up " +
      "after the agenda in the system prompt was built. Results join the session's context.",
    parameters: Schema.Struct({
      query: Schema.String,
      from: Schema.optionalKey(Schema.String),
      to: Schema.optionalKey(Schema.String),
      on: Schema.optionalKey(Schema.Literals(["happened", "said"])),
      phase: Schema.optionalKey(
        Schema.Literals(["upcoming", "past", "current", "any"]),
      ),
      kinds: Schema.optionalKey(
        Schema.Array(
          Schema.Literals(["fact", "event", "state", "task", "recurring"]),
        ),
      ),
      entity: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int),
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Session.CurrentSession],
  }),
  ownerOnlyTool(
    "memory_forget",
    "Irreversibly erase memories and every version of them. Only when the owner explicitly asks.",
  ),
  ownerOnlyTool("memory_keep", "Mark memories to keep so they never fade."),
  ownerOnlyTool("memory_unkeep", "Undo memory_keep."),
)

// Hermes: tool_error. The model sees the string as the tool's failure.
const toolError = (tool: string) => (error: DaemonFailure) =>
  error._tag === "DaemonUnavailable"
    ? "Asphodel's daemon can't be reached right now; try again later."
    : `${tool}: Asphodel answered ${error.status}: ${error.message}`

const MemoryHandlers = Memory.toLayer(
  Effect.gen(function* () {
    const asphodel = yield* Asphodel

    const ownerOnly =
      (tool: "memory_forget" | "memory_keep" | "memory_unkeep") =>
      ({ ids }: { readonly ids: ReadonlyArray<string> }) =>
        Effect.gen(function* () {
          const current = yield* Session.CurrentSession
          const turn = yield* current.turn
          if (!asphodel.isOwnerTurn(turn))
            return yield* Effect.fail(`Only the owner may call ${tool}.`)
          if (ids.length < 1 || ids.length > MAX_IDS)
            return yield* Effect.fail(
              `${tool} needs 1 to ${MAX_IDS} memory ids.`,
            )
          const body =
            tool === "memory_forget"
              ? { ids, session_id: current.session.id }
              : { ids }
          const result = yield* asphodel
            .bank("POST", `/${tool.slice("memory_".length)}`, {
              body,
              timeout: "10 seconds",
            })
            .pipe(Effect.mapError(toolError(tool)))
          if (tool === "memory_forget" && Option.isSome(turn)) {
            // Hermes finds this by scanning the transcript for the tool call.
            // clanka has no tool-call rows, so the handler records it.
            yield* Effect.orDie(asphodel.forgets.set(turn.value.id, "1")) // adjusted: TIM-559
            // The forget request isn't sent again as the next previous_query.
            asphodel.last.delete(current.session.id)
          }
          return result as Schema.Json
        })

    return Memory.of({
      memory_recall: (request) =>
        Effect.gen(function* () {
          const { session } = yield* Session.CurrentSession
          if (!request.query.trim())
            return yield* Effect.fail("memory_recall needs a non-empty query.")
          const result = yield* asphodel
            .bank("POST", "/recall", {
              body: { ...request, session_id: session.id },
              timeout: "10 seconds",
            })
            .pipe(Effect.mapError(toolError("memory_recall")))
          return typeof result?.text === "string" && result.text.trim()
            ? (result.text as string)
            : "No memories recalled."
        }),
      memory_forget: ownerOnly("memory_forget"),
      memory_keep: ownerOnly("memory_keep"),
      memory_unkeep: ownerOnly("memory_unkeep"),
    })
  }),
)

const MemoryTools = Plugin.toolkit(Memory).pipe(Layer.provide(MemoryHandlers))

// -- the hooks ------------------------------------------------------------------

// Hermes: system_prompt_block, a 2s budget and one retry.
//
// chad renders a chunk before every turn. The daemon's fetch is not a plain
// read: with a session id it maps the session to the block and marks the
// block's memories as in context. So the plugin fetches once per session and
// answers from its store until the session is compacted or reset. Hermes
// needed `_pending_block_id` because it could fetch before it knew the
// session id. chad passes the session, so that is gone.
//
// When the fetch fails the chunk is empty and nothing is stored, so the next
// turn tries again and the block arrives as an update message. In Hermes a
// session that starts while the daemon is down never gets its block.
const PromptChunk = Plugin.prompt(
  (session) =>
    Effect.gen(function* () {
      const asphodel = yield* Asphodel
      const known = yield* asphodel.blocks.get(session.id)
      if (known !== undefined) return known
      const block = yield* asphodel
        .bank("GET", "/system-prompt", {
          query: { session_id: session.id },
          timeout: "2 seconds",
        })
        .pipe(
          Effect.retry({
            times: 1,
            while: (error) => error._tag === "DaemonUnavailable",
          }),
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning(
                `${asphodel.name}: no system prompt block (${error._tag})`,
              ),
              undefined,
            ),
          ),
        )
      if (typeof block?.text !== "string") return ""
      yield* asphodel.blocks.set(session.id, block.text)
      return block.text as string
    }),
  { timeout: "5 seconds" },
)

// Hermes: on_turn_start and prefetch, a 5s budget.
const Prefetch = Plugin.beforeTurn((turn) =>
  Effect.gen(function* () {
    const asphodel = yield* Asphodel
    // A cron turn has no speaker and nothing to recall for.
    if (turn.origin._tag !== "Message") return
    // The first attempt of a resumed turn already put its context in the
    // history, and its recall id is still in the store.
    if (turn.resumed) return
    // `turn.prompt` is what chad sends the model. The owner's words are here.
    const query = turn.origin.message.text
    if (!query.trim()) return
    const previous = asphodel.last.get(turn.session.id)
    const result = yield* asphodel.bank("POST", "/prefetch", {
      timeout: "5 seconds",
      body: {
        session_id: turn.session.id,
        query,
        ...(previous ? { previous_query: previous.query } : {}),
        ...(previous?.reply ? { previous_reply: previous.reply } : {}),
      },
    })
    asphodel.last.set(turn.session.id, { turnId: turn.id, query })
    if (typeof result?.recall_id === "string")
      yield* asphodel.recalls.set(turn.id, result.recall_id)
    return typeof result?.text === "string" && result.text
      ? (result.text as string)
      : undefined
  }),
)

// Hermes: sync_turn. Hermes matches a sync to its prefetch by comparing the
// user text, and guards the reply with a set of digests, because it has no
// turn id. chad's `turn.id` replaces both.
const SyncTurn = Plugin.afterTurn(({ turn, steers, outcome }) =>
  Effect.gen(function* () {
    const asphodel = yield* Asphodel
    // Hermes: agent_context == "primary" and human_turn(). A turn a plugin
    // started is not a conversation with the owner.
    if (turn.origin._tag !== "Message") return
    const { message } = turn.origin

    // The recall id is echoed once, whatever happens to the turn.
    const recallId = yield* asphodel.recalls.get(turn.id)
    yield* asphodel.recalls.remove(turn.id)
    const forgetRequested = (yield* asphodel.forgets.get(turn.id)) !== undefined // adjusted: TIM-559
    yield* asphodel.forgets.remove(turn.id) // adjusted: TIM-559

    // Parity with Hermes: a turn that was stopped or failed is not ingested.
    if (outcome._tag !== "Answered") return
    const last = asphodel.last.get(turn.session.id)
    if (last?.turnId === turn.id)
      last.reply = outcome.text.slice(0, RERANK_CONTEXT_CHARS)
    if (!asphodel.config.ingest) return

    const body = {
      session_id: turn.session.id,
      // The owner's message time, also for a resumed turn. The daemon's
      // idempotency key is session, time and a hash of the text.
      message_at: DateTime.formatIso(message.timestamp),
      timezone: asphodel.timezone,
      // Messages that steered the turn are the owner's words too.
      user_text: [message.text, ...steers.map((steer) => steer.text)].join(
        "\n\n",
      ),
      assistant_text: outcome.text,
      author: {
        id: message.author.id,
        name: message.author.name ?? null,
        is_bot: message.author.isBot,
      },
      platform: turn.session.thread.platform,
      recall_id: recallId ?? null,
      forget_requested: forgetRequested,
    }
    const sent = yield* asphodel
      .bank("POST", "/turns", { body, timeout: "10 seconds" })
      .pipe(Effect.result)
    if (sent._tag === "Success") return yield* asphodel.replaySpool
    if (
      sent.failure._tag === "DaemonUnavailable" ||
      sent.failure.status >= 500
    ) {
      yield* Effect.logWarning(
        `${asphodel.name}: ingest failed (${sent.failure._tag}); spooling the turn`,
      )
      return yield* asphodel.spoolTurn(turn, body)
    }
    yield* Effect.logWarning(
      `${asphodel.name}: daemon answered ${sent.failure.status}; dropping the turn`,
    )
  }),
)

// Hermes: on_session_switch for reset and compression. chad has no rewind.
// Neither case needs to read the old session's history: every turn was sent
// to the daemon when it ended.
const SessionSwitch = Plugin.onSession((event) =>
  Effect.gen(function* () {
    const asphodel = yield* Asphodel
    const ended =
      event._tag === "Reset"
        ? event.previous
        : event._tag === "Compacted"
          ? event.session
          : undefined
    if (!ended) return
    yield* asphodel.blocks.remove(ended.id)
    asphodel.last.delete(ended.id)
    yield* asphodel.bank(
      "POST",
      `/sessions/${encodeURIComponent(ended.id)}/clear`,
      { timeout: "2 seconds" },
    )
  }),
)

// Hermes replays the spool only after an ingest succeeds. This fiber also // adjusted: TIM-559
// does it on a timer. chad forks it when it activates this version, so it // adjusted: TIM-559
// never runs next to the previous version's fiber, and unloading the plugin // adjusted: TIM-559
// interrupts it. // adjusted: TIM-559
const SpoolReplay = Plugin.background(
  // adjusted: TIM-559
  Effect.gen(function* () {
    // adjusted: TIM-559
    const asphodel = yield* Asphodel // adjusted: TIM-559
    yield* asphodel.replaySpool.pipe(Effect.repeat(Schedule.spaced("1 minute"))) // adjusted: TIM-559
  }), // adjusted: TIM-559
) // adjusted: TIM-559

const plugin = Layer.mergeAll(
  MemoryTools,
  PromptChunk,
  Prefetch,
  SyncTurn,
  SessionSwitch,
  SpoolReplay,
) // adjusted: TIM-559

export default plugin.pipe(Layer.provide(Asphodel.layer), Plugin.make) // adjusted: TIM-559
