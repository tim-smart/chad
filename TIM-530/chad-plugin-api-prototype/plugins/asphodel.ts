// PROTOTYPE for TIM-530. Throwaway skeleton of asphodel's Hermes plugin on
// chad's plugin API. The daemon client is a stub. What matters is where each
// Hermes hook lands. The comments name the Hermes hook each part replaces.
import { Plugin, Session } from "chad"
import { Tool, Toolkit } from "effect/ai"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"

class DaemonUnavailable extends Data.TaggedError("DaemonUnavailable")<{ readonly reason: string }> {}

interface SessionState {
  lastQuery: string | undefined
  lastReply: string | undefined
  recallId: string | undefined
  forgetRequested: boolean
}

// -- the plugin's own service: config, client, spool, per-session state --------

class Asphodel extends Context.Service<Asphodel>()("asphodel/Asphodel", {
  make: Effect.gen(function*() {
    const { name, store } = yield* Plugin.PluginContext

    // Hermes: get_config_schema, save_config and the config file.
    const config = yield* Config.all({
      url: Config.String("url").pipe(Config.withDefault("http://127.0.0.1:7720")),
      token: Config.option(Config.Redacted("token")),
      bank: Config.String("bank").pipe(Config.withDefault("chad")),
      ownerIds: Config.schema(Schema.Array(Schema.String), "ownerPlatformIds"),
      ingest: Config.Boolean("ingest").pipe(Config.withDefault(true)),
      timezone: Config.option(Config.String("timezone"))
    })

    // Stub. The real client wraps HttpClient with the bearer token and the
    // circuit breaker (3 connection failures open it for 30s).
    const http = yield* HttpClient.HttpClient
    const daemon = (path: string, body?: unknown): Effect.Effect<any, DaemonUnavailable> =>
      Effect.fail(
        new DaemonUnavailable({ reason: `stub: ${config.url}/v1/banks/${config.bank}${path} ${typeof http} ${typeof body}` })
      )

    const spool = KeyValueStore.prefix(store, "spool/")
    const sessions = new Map<string, SessionState>()
    const stateOf = (session: Session.Session): SessionState => {
      let state = sessions.get(session.id)
      if (!state) {
        state = { lastQuery: undefined, lastReply: undefined, recallId: undefined, forgetRequested: false }
        sessions.set(session.id, state)
      }
      return state
    }

    // Hermes: is_owner. A turn a plugin started (cron) is never the owner's.
    const isOwner = (turn: Option.Option<Session.Turn>): boolean =>
      Option.isSome(turn) &&
      turn.value.origin._tag === "Message" &&
      !turn.value.origin.message.author.isBot &&
      config.ownerIds.includes(`${turn.value.session.thread.platform}:${turn.value.origin.message.author.id}`)

    // Hermes: initialize. The health probe and the bank setup. A daemon that
    // is down must not fail the load, so the plugin catches it here.
    yield* daemon("", { owner_platform_ids: config.ownerIds }).pipe(
      Effect.timeout("2 seconds"),
      Effect.catch((error) => Effect.logWarning(`${name}: daemon not ready`, error))
    )

    // The spool. Hermes replays it only after a successful ingest. Here a
    // background fiber does it, and unloading the plugin interrupts the fiber.
    const replaySpool = Effect.gen(function*() {
      for (const key of [...(yield* spool.keys)].sort()) {
        const turn = yield* spool.get(key)
        if (turn === undefined) continue
        yield* daemon("/turns", JSON.parse(turn))
        yield* spool.remove(key)
      }
    })
    yield* replaySpool.pipe(
      Effect.catch((error) => Effect.logDebug(`${name}: spool replay stopped`, error)),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped
    )

    // Hermes: shutdown.
    yield* Effect.addFinalizer(() => Effect.logInfo(`${name}: unloaded`))

    return { config, daemon, spool, stateOf, isOwner, forget: (session: Session.Session) => sessions.delete(session.id) }
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}

// -- the four tools (Hermes: get_tool_schemas + handle_tool_call) ---------------

const Ids = Schema.Struct({ ids: Schema.Array(Schema.String) })
const memoryTool = <const Name extends string, P extends Schema.Top>(name: Name, description: string, parameters: P) =>
  Tool.make(name, {
    description,
    parameters,
    success: Schema.Json,
    failure: Schema.String,
    dependencies: [Session.CurrentSession]
  })

const Memory = Toolkit.make(
  memoryTool(
    "memory_recall",
    "Search Asphodel's long-term memory for what the user has said or done.",
    Schema.Struct({ query: Schema.String, limit: Schema.optionalKey(Schema.Int) })
  ),
  memoryTool("memory_forget", "Irreversibly erase memories. Only the owner may call it.", Ids),
  memoryTool("memory_keep", "Mark memories to keep so they never fade. Only the owner may call it.", Ids),
  memoryTool("memory_unkeep", "Undo memory_keep. Only the owner may call it.", Ids)
)

const MemoryHandlers = Memory.toLayer(Effect.gen(function*() {
  const { daemon, isOwner, stateOf } = yield* Asphodel

  const ownerOnly = (path: string) => ({ ids }: { readonly ids: ReadonlyArray<string> }) =>
    Effect.gen(function*() {
      const current = yield* Session.CurrentSession
      if (!isOwner(yield* current.turn)) return yield* Effect.fail("Only the owner may call this tool.")
      if (path === "/forget") stateOf(current.session).forgetRequested = true
      return yield* daemon(path, { ids, session_id: current.session.id }).pipe(
        Effect.mapError((error) => error.reason)
      )
    })

  return Memory.of({
    memory_recall: (request) =>
      Effect.gen(function*() {
        const { session } = yield* Session.CurrentSession
        return yield* daemon("/recall", { ...request, session_id: session.id }).pipe(
          Effect.mapError((error) => error.reason)
        )
      }),
    memory_forget: ownerOnly("/forget"),
    memory_keep: ownerOnly("/keep"),
    memory_unkeep: ownerOnly("/unkeep")
  })
}))

const MemoryTools = Plugin.toolkit(Memory).pipe(Layer.provide(MemoryHandlers))

// -- the hooks ------------------------------------------------------------------

// Hermes: system_prompt_block, 2s budget and one retry.
const PromptChunk = Plugin.prompt(
  (session) =>
    Effect.gen(function*() {
      const { daemon } = yield* Asphodel
      const result = yield* daemon(`/system-prompt?session_id=${session.id}`).pipe(
        Effect.timeout("2 seconds"),
        Effect.retry({ times: 1 })
      )
      return (result.text ?? "") as string
    }),
  { timeout: "5 seconds" }
)

// Hermes: prefetch (5s budget) and on_turn_start (the author).
const Prefetch = Plugin.beforeTurn((turn) =>
  Effect.gen(function*() {
    if (turn.origin._tag !== "Message") return
    const { daemon, stateOf } = yield* Asphodel
    const state = stateOf(turn.session)
    state.forgetRequested = false
    const result = yield* daemon("/prefetch", {
      session_id: turn.session.id,
      query: turn.prompt,
      previous_query: state.lastQuery,
      previous_reply: state.lastReply
    })
    state.lastQuery = turn.prompt
    state.recallId = result.recall_id
    return result.text as string | undefined
  })
)

// Hermes: sync_turn. Ingest the turn, spool it when the daemon is down.
const SyncTurn = Plugin.afterTurn(({ turn, steers, outcome }) =>
  Effect.gen(function*() {
    const { config, daemon, spool, stateOf } = yield* Asphodel
    if (!config.ingest || turn.origin._tag !== "Message" || outcome._tag !== "Answered") return
    const state = stateOf(turn.session)
    const { message } = turn.origin
    state.lastReply = outcome.text.slice(0, 300)
    const body = {
      session_id: turn.session.id,
      message_at: DateTime.formatIso(message.timestamp),
      timezone: Option.getOrUndefined(config.timezone),
      user_text: [turn.prompt, ...steers.map((steer) => steer.text)].join("\n\n"),
      assistant_text: outcome.text,
      author: { id: message.author.id, name: message.author.name, is_bot: message.author.isBot },
      platform: turn.session.thread.platform,
      recall_id: state.recallId,
      forget_requested: state.forgetRequested
    }
    state.recallId = undefined
    yield* daemon("/turns", body).pipe(
      Effect.catch(() => spool.set(`${DateTime.formatIso(turn.startedAt)}-${turn.id}`, JSON.stringify(body)))
    )
  })
)

// Hermes: on_session_switch for reset and compression.
const SessionSwitch = Plugin.onSession((event) =>
  Effect.gen(function*() {
    const { daemon, forget } = yield* Asphodel
    const ended = event._tag === "Reset" ? event.previous : event.session
    forget(ended)
    yield* daemon(`/sessions/${ended.id}/clear`, {})
  })
)

// The other way to use `Plugin.make`: merge first, provide the plugin's own
// service once, and check last.
export default Layer.mergeAll(MemoryTools, PromptChunk, Prefetch, SyncTurn, SessionSwitch).pipe(
  Layer.provide(Asphodel.layer),
  Plugin.make
)
