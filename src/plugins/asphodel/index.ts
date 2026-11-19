// The bundled plugin `asphodel`: long-term memory from an asphodel daemon. It sends each owner turn to the daemon, puts
// the daemon's block in each session's system prompt and the memories for each message in the turn's context, and gives
// the model four memory tools. It is off until `chad.json` turns it on with `"enabled": true` and the daemon's `url`
// and `token`. It uses only the plugin API, and its source is in `repo/examples/asphodel/`.
import {
  Clock,
  Config,
  Context,
  DateTime,
  type Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect"
import { Tool, Toolkit } from "effect/ai"
import { KeyValueStore } from "effect/persistence"
import * as Plugin from "../../Plugin.ts"
import * as Session from "../../Session.ts"
import * as Client from "./Client.ts"

/** The major version of the daemon this plugin was written for. Another one only gets a warning. */
const daemonMajor = "0"
/** How much of a reply the next prefetch sends back as `previous_reply`. */
const previousReplyChars = 300
/** The most ids one owner-only tool call takes. The daemon refuses more. */
const maxIds = 50
/** The spool keeps at most this many turns, none older than a week. */
const spoolMaxTurns = 500
const spoolMaxAgeMillis = 7 * 24 * 60 * 60 * 1000

/** A spooled turn's body, as it was stored. */
const spooled = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown),
)

// -- the plugin's own service ---------------------------------------------------
// One per load of the plugin, serving every session, so what belongs to a session or a turn is kept by its id.

class Asphodel extends Context.Service<Asphodel>()("asphodel/Asphodel", {
  make: Effect.gen(function* () {
    const { name, store, owners } = yield* Plugin.PluginContext

    // The plugin's `settings` object in chad.json. The token is written `${ASPHODEL_TOKEN}` there, and chad expands it
    // from the secret store before this read.
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
    // The setting, else the owner's timezone as chad has it.
    const timezone =
      Option.getOrElse(config.timezone, () => "") ||
      DateTime.zoneToString(yield* DateTime.CurrentTimeZone)

    const client = yield* Client.make({ url: config.url, token: config.token })

    // The bank is made, or given the owner's identity again, before the first request that reads or writes it. Until
    // a PUT works, every bank request tries it first.
    const bankPath = `/banks/${encodeURIComponent(config.bank)}`
    let bankReady = false
    const ensureBank = (
      timeout: Duration.Input,
    ): Effect.Effect<void, Client.DaemonFailure> =>
      bankReady
        ? Effect.void
        : client
            .ok("PUT", bankPath, Client.Bank, {
              timeout,
              body: {
                owner_name: Option.getOrNull(config.ownerName),
                owner_platform_ids: owners,
                assistant_name: config.assistantName,
                timezone,
              },
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  bankReady = true
                }),
              ),
              Effect.asVoid,
            )
    const bank = <A>(
      method: "GET" | "POST",
      path: string,
      answer: Client.Answer<A>,
      options: Client.Options,
    ) =>
      Effect.andThen(
        ensureBank(options.timeout),
        client.ok(method, bankPath + path, answer, options),
      )

    // At load, a health probe and the bank PUT. A daemon that is down or not ready must not fail the load, so each
    // problem is a warning in the log, and memory starts working once the daemon answers.
    yield* client.request("GET", "/health", { timeout: "2 seconds" }).pipe(
      Effect.tap(({ status, json }) => {
        const health = Schema.decodeUnknownOption(Client.Health)(json)
        if (status !== 200 || Option.isNone(health) || !health.value.ready)
          return Effect.logWarning(
            `${name}: the daemon isn't ready yet (status ${status})`,
          )
        const { version } = health.value
        if (version.split(".")[0] !== daemonMajor) {
          return Effect.logWarning(
            `${name}: the daemon is ${version}, this plugin was written for ${daemonMajor}.x`,
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

    // The spool: one entry per turn the daemon did not take, in the plugin's key-value store, so a restart keeps it.
    // The key sorts oldest first.
    const spool = KeyValueStore.prefix(store, "spool/")
    const spoolTurn = Effect.fnUntraced(
      function* (turn: Session.Turn, body: unknown) {
        const now = yield* Clock.currentTimeMillis
        yield* spool.set(
          `${String(now).padStart(15, "0")}-${turn.id}`,
          JSON.stringify(body),
        )
        const keys = [...(yield* spool.keys)].sort()
        const stale = keys.filter(
          (key, index) =>
            Number(key.slice(0, 15)) < now - spoolMaxAgeMillis ||
            index < keys.length - spoolMaxTurns,
        )
        yield* Effect.forEach(stale, (key) => spool.remove(key), {
          discard: true,
        })
      },
      Effect.catch((error) =>
        Effect.logWarning(`${name}: could not spool a turn`, error),
      ),
    )
    // Sends the spooled turns oldest first. A 4xx drops the entry, since the daemon will never take it. A 5xx, no
    // answer or an answer that does not decode stops the replay and keeps the rest. An entry that is not JSON is dropped.
    const replaySpool: Effect.Effect<void> = Effect.gen(function* () {
      for (const key of [...(yield* spool.keys)].sort()) {
        const body = Option.flatMap(
          Option.fromUndefinedOr(yield* spool.get(key)),
          spooled,
        )
        if (Option.isSome(body)) {
          const sent = yield* bank("POST", "/turns", Client.Ingested, {
            body: body.value,
            timeout: "10 seconds",
          }).pipe(Effect.result)
          if (sent._tag === "Failure" && !Client.refused(sent.failure)) return
        }
        yield* spool.remove(key)
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`${name}: spool replay failed`, error),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.logInfo(`${name}: unloaded`))

    // The owner is whoever sent the message a turn started from, when their id is on chad's owner list. A turn a plugin
    // started, such as a cron job's, has no message and is never the owner's. A sub-agent's turn cannot be told apart
    // from the main agent's, which is accepted. An id on the owner list is an owner whether or not it is a bot.
    const isOwnerTurn = (turn: Option.Option<Session.Turn>): boolean => {
      if (Option.isNone(turn) || turn.value.origin._tag !== "Message")
        return false
      const { author } = turn.value.origin.message
      return owners.includes(
        `${turn.value.session.thread.platform}:${author.id}`,
      )
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
       * The system prompt block each session was given, by session id. Kept in the store so a restart or a reload of
       * the plugin does not fetch a second block for a session that already has one.
       */
      blocks: KeyValueStore.prefix(store, "block/"),
      /** The last prefetch of each session, for `previous_query` and `previous_reply`. */
      last: new Map<
        string,
        { readonly turnId: string; readonly query: string; reply?: string }
      >(),
      /**
       * The turns in which `memory_forget` worked, by turn id, so the ingest says so. Kept in the store so a reload of
       * the plugin between the tool call and the end of the turn does not lose the mark.
       */
      forgets: KeyValueStore.prefix(store, "forget/"),
      /** The recall ids waiting for their turn to end, by turn id. Kept in the store so a resumed turn finds its own. */
      recalls: KeyValueStore.prefix(store, "recall/"),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

// -- the four tools -------------------------------------------------------------

const Ids = Schema.Struct({ ids: Schema.Array(Schema.String) })
const ownerOnlyTool = <const Name extends string, S extends Schema.Top>(
  name: Name,
  description: string,
  success: S,
) =>
  Tool.make(name, {
    description: `${description} Only the owner may call it. Get ids from memory_recall; injected memories carry no ids.`,
    parameters: Ids,
    success,
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
    Client.Forgotten,
  ),
  ownerOnlyTool(
    "memory_keep",
    "Mark memories to keep so they never fade.",
    Client.Kept,
  ),
  ownerOnlyTool("memory_unkeep", "Undo memory_keep.", Client.Unkept),
)

/** What the model sees as a tool's failure. */
const toolError = (tool: string) => (error: Client.DaemonFailure) =>
  error._tag === "DaemonUnavailable"
    ? "Asphodel's daemon can't be reached right now; try again later."
    : error._tag === "DaemonInvalid"
      ? `${tool}: Asphodel's answer could not be read (${error.message}); try again later.`
      : `${tool}: Asphodel answered ${error.status}: ${error.message}`

const MemoryHandlers = Memory.toLayer(
  Effect.gen(function* () {
    const asphodel = yield* Asphodel

    /** The checks every owner-only tool makes before it sends anything: an owner's turn, and 1 to 50 ids. */
    const ownerCall = Effect.fnUntraced(function* (
      tool: "memory_forget" | "memory_keep" | "memory_unkeep",
      ids: ReadonlyArray<string>,
    ) {
      const current = yield* Session.CurrentSession
      const turn = yield* current.turn
      if (!asphodel.isOwnerTurn(turn))
        return yield* Effect.fail(`Only the owner may call ${tool}.`)
      if (ids.length < 1 || ids.length > maxIds)
        return yield* Effect.fail(`${tool} needs 1 to ${maxIds} memory ids.`)
      return { session: current.session, turn }
    })

    return Memory.of({
      memory_recall: Effect.fnUntraced(function* (request) {
        const { session } = yield* Session.CurrentSession
        if (!request.query.trim())
          return yield* Effect.fail("memory_recall needs a non-empty query.")
        const result = yield* asphodel
          .bank("POST", "/recall", Client.Recall, {
            body: { ...request, session_id: session.id },
            timeout: "10 seconds",
          })
          .pipe(Effect.mapError(toolError("memory_recall")))
        return result.text.trim() ? result.text : "No memories recalled."
      }),
      memory_forget: Effect.fnUntraced(function* ({ ids }) {
        const { session, turn } = yield* ownerCall("memory_forget", ids)
        const result = yield* asphodel
          .bank("POST", "/forget", Client.Forgotten, {
            body: { ids, session_id: session.id },
            timeout: "10 seconds",
          })
          .pipe(Effect.mapError(toolError("memory_forget")))
        if (Option.isSome(turn)) {
          // The turn's ingest carries `forget_requested`, so the daemon stores it as a tombstone.
          yield* Effect.orDie(asphodel.forgets.set(turn.value.id, "1"))
          // The forget request is not sent again as the next prefetch's previous_query.
          asphodel.last.delete(session.id)
        }
        return result
      }),
      memory_keep: ({ ids }) =>
        ownerCall("memory_keep", ids).pipe(
          Effect.andThen(
            asphodel
              .bank("POST", "/keep", Client.Kept, {
                body: { ids },
                timeout: "10 seconds",
              })
              .pipe(Effect.mapError(toolError("memory_keep"))),
          ),
        ),
      memory_unkeep: ({ ids }) =>
        ownerCall("memory_unkeep", ids).pipe(
          Effect.andThen(
            asphodel
              .bank("POST", "/unkeep", Client.Unkept, {
                body: { ids },
                timeout: "10 seconds",
              })
              .pipe(Effect.mapError(toolError("memory_unkeep"))),
          ),
        ),
    })
  }),
)

const MemoryTools = Plugin.toolkit(Memory).pipe(Layer.provide(MemoryHandlers))

// -- the hooks ------------------------------------------------------------------

// The block in the system prompt, in a 2 second budget with one retry.
//
// chad renders a chunk before every turn, but the daemon's fetch is not a plain read: with a session id it maps the
// session to the block and marks the block's memories as in context. So the plugin fetches once per session and answers
// from its store until the session is compacted or reset.
//
// When the fetch fails the chunk is empty and nothing is stored, so the next turn tries again and the block arrives as
// an update to the system prompt.
const PromptChunk = Plugin.prompt(
  (session) =>
    Effect.gen(function* () {
      const asphodel = yield* Asphodel
      const known = yield* asphodel.blocks.get(session.id)
      if (known !== undefined) return known
      const block = yield* asphodel
        .bank("GET", "/system-prompt", Client.Block, {
          query: { session_id: session.id },
          timeout: "2 seconds",
        })
        .pipe(
          Effect.retry({
            times: 1,
            while: (error) => error._tag === "DaemonUnavailable",
          }),
          Effect.asSome,
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning(
                `${asphodel.name}: no system prompt block (${error._tag})`,
              ),
              Option.none(),
            ),
          ),
        )
      if (Option.isNone(block)) return ""
      yield* asphodel.blocks.set(session.id, block.value.text)
      return block.value.text
    }),
  { timeout: "5 seconds" },
)

// The memories for the owner's message, in the turn's context, in a 5 second budget.
const Prefetch = Plugin.beforeTurn((turn) =>
  Effect.gen(function* () {
    const asphodel = yield* Asphodel
    // A turn a plugin started has no speaker and nothing to recall for.
    if (turn.origin._tag !== "Message") return
    // The first attempt of a resumed turn already put its context in the history, and its recall id is still in the
    // store.
    if (turn.resumed) return
    // `turn.prompt` is what chad sends the model, and the owner's own words are the message's text.
    const query = turn.origin.message.text
    if (!query.trim()) return
    const previous = asphodel.last.get(turn.session.id)
    const result = yield* asphodel.bank("POST", "/prefetch", Client.Prefetch, {
      timeout: "5 seconds",
      body: {
        session_id: turn.session.id,
        query,
        ...(previous ? { previous_query: previous.query } : {}),
        ...(previous?.reply ? { previous_reply: previous.reply } : {}),
      },
    })
    asphodel.last.set(turn.session.id, { turnId: turn.id, query })
    yield* asphodel.recalls.set(turn.id, result.recall_id)
    return result.text || undefined
  }),
)

// The turn's ingest when it ends. `turn.id` ties it to its prefetch, and a resumed turn keeps the id.
const SyncTurn = Plugin.afterTurn(({ turn, steers, outcome }) =>
  Effect.gen(function* () {
    const asphodel = yield* Asphodel
    // A turn a plugin started is not a conversation with the owner.
    if (turn.origin._tag !== "Message") return
    const { message } = turn.origin

    // The recall id is echoed once, whatever happens to the turn.
    const recallId = yield* asphodel.recalls.get(turn.id)
    yield* asphodel.recalls.remove(turn.id)
    const forgetRequested = (yield* asphodel.forgets.get(turn.id)) !== undefined
    yield* asphodel.forgets.remove(turn.id)

    // A turn that was stopped or failed is not ingested.
    if (outcome._tag !== "Answered") return
    const last = asphodel.last.get(turn.session.id)
    if (last?.turnId === turn.id)
      last.reply = outcome.text.slice(0, previousReplyChars)
    if (!asphodel.config.ingest) return

    const body = {
      session_id: turn.session.id,
      // The owner's message time, also for a resumed turn. The daemon's idempotency key is the session, this time and
      // a hash of the text, so a turn sent twice is stored once.
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
      .bank("POST", "/turns", Client.Ingested, {
        body,
        timeout: "10 seconds",
      })
      .pipe(Effect.result)
    if (sent._tag === "Success") return yield* asphodel.replaySpool
    if (!Client.refused(sent.failure)) {
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

// A session that ends by a reset or a compaction lets go of its block, so the next session fetches its own, and the
// daemon clears what it holds for it. Neither needs the old session's history: every turn was sent when it ended.
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
      Client.NoContent,
      { timeout: "2 seconds" },
    )
  }),
)

// The spool is replayed after each ingest that works, and by this fiber once a minute, so a quiet daemon that comes
// back still gets its turns. chad forks it when it activates this version, so it never runs next to the previous
// version's fiber, and unloading the plugin interrupts it.
const SpoolReplay = Plugin.background(
  Effect.gen(function* () {
    const asphodel = yield* Asphodel
    yield* asphodel.replaySpool.pipe(Effect.repeat(Schedule.spaced("1 minute")))
  }),
)

const plugin = Layer.mergeAll(
  MemoryTools,
  PromptChunk,
  Prefetch,
  SyncTurn,
  SessionSwitch,
  SpoolReplay,
)

export default plugin.pipe(Layer.provide(Asphodel.layer), Plugin.make)
