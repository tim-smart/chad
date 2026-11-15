// The local platform of docs/spec/17-testing.md: effect/chat's ChatTest and the RPC server the adapter client talks
// to. It runs outside the daemon and is never in the image.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { DiscordChat } from "@effect/chat-discord"
import { DiscordREST } from "dfx"
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Queue,
  type Scope,
  Stream,
} from "effect"
import {
  Chat,
  ChatAdapter,
  type ChatEvent,
  ChatHandler,
  ChatTest,
} from "effect/chat"
import { RpcSerialization, RpcServer } from "effect/rpc"
import * as LocalChat from "../../dist/daemon/LocalChat.js"

/** The name of the platform in a thread string, such as `local:1`. */
export const name = "local"

/**
 * The Discord adapter's own descriptor. ChatTest takes its limits and capabilities from it, so that a split is tested
 * against Discord's numbers and not ChatTest's defaults. The adapter is built on a REST service it never calls.
 */
export const discordDescriptor = Effect.gen(function* () {
  const registry = yield* ChatAdapter.Registry
  const descriptors = yield* registry.descriptors
  return descriptors[0]!
}).pipe(
  Effect.provide(
    DiscordChat.layer.pipe(
      Layer.provideMerge(Chat.layer),
      Layer.provide(Layer.succeed(DiscordREST, {} as never)),
      Layer.provide(NodeHttpClient.layerUndici),
    ),
  ),
)

type Handler = ChatHandler.ChatHandler["Service"]

export interface Platform {
  readonly chat: ChatTest.ChatTest["Service"]
  /** Hands an event to the daemon that is attached, and waits for one when none is. */
  readonly deliver: (
    event: ChatEvent.ChatEvent,
  ) => Effect.Effect<void, ChatHandler.NotAccepted>
  /** The number of writes the daemon has made to the chat. */
  readonly writes: () => number
  /** Resolves once the daemon has made more writes than `seen`. */
  readonly written: (seen: number) => Effect.Effect<void>
  /** The chat Layer of a daemon in the same process, with no socket in between. */
  readonly layer: Layer.Layer<
    never,
    never,
    ChatAdapter.Registry | ChatHandler.ChatHandler
  >
  /** The handlers of the adapter client's requests. */
  readonly handlers: Layer.Layer<
    import("effect/rpc/Rpc").ToHandler<
      import("effect/rpc/RpcGroup").Rpcs<typeof LocalChat.Rpcs>
    >
  >
}

/** Listens at a socket path with the given handlers, which is what makes the platform reachable from a daemon. */
export const serve = <Rpcs extends import("effect/rpc/Rpc").Any, R>(
  group: import("effect/rpc/RpcGroup").RpcGroup<Rpcs>,
  handlers: Layer.Layer<R>,
  path: string,
) =>
  RpcServer.layer(group).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocketServer.layer({ path })),
  )

export const make = (
  record: (kind: string, fields: object) => void,
): Effect.Effect<Platform, never, Scope.Scope> =>
  Effect.gen(function* () {
    const discord = yield* discordDescriptor
    const context = yield* Layer.build(
      ChatTest.layer({
        platform: name,
        capabilities: [...discord.capabilities],
        limits: discord.limits,
        measure: discord.measure,
      }),
    )
    const chat = Context.get(context, ChatTest.ChatTest)
    const registry = Context.get(context, ChatAdapter.Registry)
    const inner = yield* registry.get(name).pipe(Effect.orDie)

    // The writes are what a scenario waits on, so each one wakes the waiters and goes to the event log.
    let writes = 0
    let waiters: Array<() => void> = []
    const wrote = <A, E, R>(op: string, effect: Effect.Effect<A, E, R>) =>
      Effect.onExit(effect, (exit) =>
        Effect.sync(() => {
          record("chat", { op, outcome: exit._tag })
          writes++
          const waiting = waiters
          waiters = []
          for (const wake of waiting) wake()
        }),
      )
    const adapter: ChatAdapter.ChatAdapter = {
      ...inner,
      post: (thread, content) => wrote("post", inner.post(thread, content)),
      edit: (thread, id, content) =>
        wrote("edit", inner.edit(thread, id, content)),
      delete: (thread, id) => wrote("delete", inner.delete(thread, id)),
    }

    let handler: Handler | undefined
    let attached: Array<() => void> = []
    const attach = (next: Handler) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          handler = next
          const waiting = attached
          attached = []
          for (const wake of waiting) wake()
        }),
        () =>
          Effect.sync(() => {
            if (handler === next) handler = undefined
          }),
      )
    const current: Effect.Effect<Handler> = Effect.suspend(() =>
      handler !== undefined
        ? Effect.succeed(handler)
        : Effect.andThen(
            Effect.callback<void>((resume) => {
              attached.push(() => resume(Effect.void))
            }),
            current,
          ),
    )

    let events = 0
    const pending = new Map<string, Deferred.Deferred<boolean>>()

    return {
      chat,
      deliver: (event) =>
        Effect.flatMap(current, (attachedHandler) => {
          record("deliver", { event: event._tag })
          return chat
            .deliver(event)
            .pipe(
              Effect.provideService(ChatHandler.ChatHandler, attachedHandler),
            )
        }),
      writes: () => writes,
      written: (seen) =>
        Effect.callback<void>((resume) => {
          if (writes > seen) resume(Effect.void)
          else waiters.push(() => resume(Effect.void))
        }),
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const daemon = yield* ChatAdapter.Registry
          yield* daemon.register(adapter)
          yield* attach(yield* ChatHandler.ChatHandler)
        }),
      ),
      handlers: LocalChat.Rpcs.toLayer({
        descriptor: () =>
          Effect.succeed({
            platform: adapter.descriptor.platform,
            capabilities: [...adapter.descriptor.capabilities],
            limits: adapter.descriptor.limits,
          }),
        post: ({ thread, ...content }) => adapter.post(thread, content),
        edit: ({ thread, messageId, ...content }) =>
          adapter.edit(thread, messageId, content),
        delete: ({ thread, messageId }) => adapter.delete(thread, messageId),
        fetchMessage: ({ thread, messageId }) =>
          adapter.fetchMessage(thread, messageId),
        history: ({ thread, ...options }) => adapter.history(thread, options),
        download: ({ thread, attachment, maxBytes }) =>
          adapter.download(thread, attachment, { maxBytes }),
        startThread: ({ thread, messageId, name }) =>
          adapter.startThread(thread, messageId, { name }),
        getThread: ({ thread }) => adapter.getThread(thread),
        opener: ({ thread }) =>
          Effect.map(adapter.opener(thread), (message) =>
            message._tag === "Some" ? message.value : null,
          ),
        getUser: ({ id, in: within }) => adapter.getUser(id, { in: within }),
        followUp: ({ deferred, ...content }) =>
          adapter.followUp(deferred, content),
        // The daemon that reads this stream is the one that gets the events, and each waits for its `ack`.
        events: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<{
                readonly id: string
                readonly event: ChatEvent.ChatEvent
              }>()
              // An event this daemon never acknowledged goes to the next daemon that attaches, as Discord replays an
              // event whose sequence was not stored (TST-54). The finalizer runs after the handler is detached.
              const gone = yield* Deferred.make<void>()
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(gone, undefined),
              )
              yield* attach({
                handle: (event) =>
                  Effect.gen(function* () {
                    const id = String(++events)
                    const accepted = yield* Deferred.make<boolean>()
                    pending.set(id, accepted)
                    yield* Queue.offer(queue, { id, event })
                    const answer = yield* Deferred.await(accepted).pipe(
                      Effect.raceFirst(
                        Effect.as(Deferred.await(gone), "gone" as const),
                      ),
                    )
                    if (answer === "gone") {
                      pending.delete(id)
                      record("redeliver", { event: event._tag })
                      return yield* (yield* current).handle(event)
                    }
                    if (!answer) return yield* new ChatHandler.NotAccepted()
                  }),
              })
              return Stream.fromQueue(queue)
            }),
          ),
        ack: ({ id, accepted }) =>
          Effect.suspend(() => {
            const waiting = pending.get(id)
            pending.delete(id)
            return waiting === undefined
              ? Effect.void
              : Effect.asVoid(Deferred.succeed(waiting, accepted))
          }),
      }),
    }
  })
