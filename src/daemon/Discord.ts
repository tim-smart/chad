import { DiscordChat } from "@effect/chat-discord"
import * as DiscordConfig from "dfx/DiscordConfig"
import { DiscordGateway, DiscordGatewayLive } from "dfx/DiscordGateway"
import { JsonDiscordWSCodecLive } from "dfx/DiscordGateway/DiscordWS"
import { DispatchHook } from "dfx/DiscordGateway/Shard/DispatchHook"
import { ShardStateStore } from "dfx/DiscordGateway/Shard/StateStore"
import { MemoryShardStoreLive } from "dfx/DiscordGateway/ShardStore"
import { DiscordREST, DiscordRESTLive } from "dfx/DiscordREST"
import { MemoryRateLimitStoreLive } from "dfx/RateLimit"
import { Deferred, Effect, Exit, Layer, Queue, Redacted, Scope } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Socket } from "effect/socket"
import { intents } from "../Discord.ts"
import * as CatchUp from "./CatchUp.ts"
import * as Chats from "./Chats.ts"
import type { Connection } from "./Connection.ts"
import * as Logger from "./Logger.ts"
import * as SlashCommands from "./SlashCommands.ts"

/** effect's Discord adapter module, for the address of a channel and for what a caller sets on a post. */
export { DiscordChat }

/**
 * The one list of intents and permissions, which the CLI builds the invite URL of `chad connection add discord`
 * from. The gateway identifies with these intents.
 */
export { intents, permissions, privilegedIntents } from "../Discord.ts"

/** The table that holds dfx's shard state. The key-value layer creates it, and no migration does. */
export const shardTable = "core_discord_shards"

/**
 * The close codes after which Discord takes no new session from the same bot: a bad token, a wrong shard, a wrong
 * API version, and intents that are not valid or not allowed.
 */
export const closedForGood: ReadonlyArray<number> = [
  4004, 4010, 4011, 4012, 4013, 4014,
]

/**
 * The WebSocket constructor the gateway dials with. dfx reconnects whatever the close code and tells nobody, so this
 * is where chad sees a close: it logs each one, and completes `refused` with the code of one that is for good.
 */
const watched = (connection: Connection, refused: Deferred.Deferred<number>) =>
  Layer.effect(
    Socket.WebSocketConstructor,
    Effect.gen(function* () {
      const make = yield* Socket.WebSocketConstructor
      const run = Effect.runForkWith(yield* Effect.context<never>())
      return (url, protocols) => {
        const socket = make(url, protocols)
        let closedByChad = false
        const close = socket.close.bind(socket)
        socket.close = (code, reason) => {
          closedByChad = true
          close(code, reason)
        }
        socket.addEventListener(
          "close",
          (event) => {
            const code = typeof event.code === "number" ? event.code : null
            const forGood = code !== null && closedForGood.includes(code)
            run(
              Effect.gen(function* () {
                yield* Logger.event("chat.disconnected", "The gateway closed", {
                  connection: connection.name,
                  code,
                  by: closedByChad ? "chad" : "discord",
                })
                if (!forGood) return
                yield* Logger.event(
                  "chat.refused",
                  "Discord closed the gateway for good",
                  { connection: connection.name, code },
                )
                yield* Deferred.succeed(refused, code)
              }),
            )
          },
          { once: true },
        )
        return socket
      }
    }),
  )

/**
 * dfx's dispatch hook. The shard hands the hook every dispatch, `READY` among them, which is the one that follows a
 * fresh identify. After one the catch-up reads what the gateway did not replay, off the dispatch path.
 */
const caughtUp = Layer.effect(
  DispatchHook,
  Effect.gen(function* () {
    const hook = yield* DispatchHook
    const identified = yield* Queue.unbounded<void>()
    yield* Queue.take(identified).pipe(
      Effect.andThen(CatchUp.run("discord")),
      Effect.catchCause((cause) =>
        Effect.logWarning("The catch-up failed", cause),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
    return (payload, context) =>
      payload.t === "READY"
        ? hook(payload, context).pipe(
            Effect.andThen(Queue.offer(identified, undefined)),
          )
        : hook(payload, context)
  }),
).pipe(Layer.provide(DiscordChat.layerDispatchHook))

/**
 * chad's line `chat.connected`, and the daemon's word that the connection is connected, at `READY`
 * for a fresh identify and `RESUMED` for a resume. The shard stores the session and its sequence once the hook has
 * returned, and only then hands the dispatch to the gateway's subscribers. So the line, and the startup check that
 * `Chats.Connected` lets run, come after the session is stored, and a daemon killed after the line resumes it at the
 * next start. The subscriptions are in place before the shard can have a session.
 */
const connected = (connection: Connection) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const gateway = yield* DiscordGateway
      const up = yield* Chats.Connected
      const announce = (resumed: boolean) => () =>
        Logger.event("chat.connected", "The gateway session is up", {
          connection: connection.name,
          resumed,
        }).pipe(Effect.andThen(up))
      yield* Effect.forkScoped(
        gateway.handleDispatch("READY", announce(false)),
        { startImmediately: true },
      )
      yield* Effect.forkScoped(
        gateway.handleDispatch("RESUMED", announce(true)),
        { startImmediately: true },
      )
    }),
  )

/**
 * Sets the bot's slash commands to chad's at each `READY`, which names the application. The call replaces the whole
 * list Discord holds for the application. A failure is logged and the connection carries on, and the typed commands
 * still work.
 */
const commands = (connection: Connection) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const gateway = yield* DiscordGateway
      const rest = yield* DiscordREST
      yield* Effect.forkScoped(
        gateway.handleDispatch("READY", (ready) =>
          rest
            .bulkSetApplicationCommands(ready.application.id, [
              ...DiscordChat.commandRequests(SlashCommands.all),
            ])
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "The slash commands could not be registered",
                  cause,
                ),
              ),
              Effect.annotateLogs("connection", connection.name),
            ),
        ),
        { startImmediately: true },
      )
    }),
  )

const config = (connection: Connection) =>
  DiscordConfig.layer({
    token: Redacted.make(connection.token ?? ""),
    gateway: { intents },
  })

/**
 * effect's Discord adapter for one connection, over dfx's REST client, which it gives too. It registers the platform
 * `discord`.
 *
 * The adapter and the REST client are the same layer values for every connection, and a layer is built once for all
 * who ask for it. So each connection builds them afresh, and the client of one never carries the token of another.
 */
export const adapter = (connection: Connection) =>
  Layer.fresh(
    DiscordChat.layer.pipe(
      Layer.provideMerge(DiscordRESTLive),
      Layer.provide(MemoryRateLimitStoreLive),
      Layer.provide(config(connection)),
    ),
  )

/**
 * The chat platform of a Discord connection: the adapter, and dfx's gateway with the at-least-once dispatch hook and
 * its shard state in the database, under the connection's name.
 *
 * When Discord closes the gateway for good the gateway is taken down and stays down, and the rest of the daemon
 * carries on.
 */
export const layer = (connection: Connection) => {
  const shardState = ShardStateStore.KVSLive.pipe(
    Layer.provide(
      Layer.effect(
        KeyValueStore.KeyValueStore,
        Effect.map(
          KeyValueStore.KeyValueStore,
          KeyValueStore.prefix(`${connection.name}/`),
        ),
      ),
    ),
    Layer.provide(KeyValueStore.layerSql({ table: shardTable })),
  )
  // A click comes over the gateway, as `INTERACTION_CREATE`, and goes to `ChatInteraction.Handler`.
  const gateway = (refused: Deferred.Deferred<number>) =>
    DiscordChat.layerGatewayInteractions.pipe(
      Layer.provideMerge(gatewayOnly(refused)),
    )
  const gatewayOnly = (refused: Deferred.Deferred<number>) =>
    Layer.merge(connected(connection), commands(connection)).pipe(
      Layer.provideMerge(DiscordGatewayLive),
      Layer.provide([
        caughtUp,
        shardState,
        MemoryShardStoreLive,
        MemoryRateLimitStoreLive,
        JsonDiscordWSCodecLive,
        watched(connection, refused),
        config(connection),
      ]),
    )
  const built = Layer.effectDiscard(
    Effect.gen(function* () {
      const refused = yield* Deferred.make<number>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      yield* Layer.buildWithScope(gateway(refused), scope)
      yield* Deferred.await(refused).pipe(
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.forkScoped,
      )
    }),
  ).pipe(Layer.provide(adapter(connection)))
  // The gateway's layers are shared values too, so nothing of one connection's build serves another.
  return Layer.fresh(built)
}
