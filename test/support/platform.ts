// The local platform of the tests: effect/chat's ChatTest and the RPC server the adapter client talks to. It runs
// outside the daemon and is never in the image.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { DiscordChat } from "@effect/chat-discord"
import { DiscordREST } from "dfx"
import {
  Context,
  Deferred,
  Duration,
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
  ChatInteraction,
  ChatTest,
  type ChatThread,
} from "effect/chat"
import { RpcSerialization, RpcServer } from "effect/rpc"
import * as LocalChat from "../../dist/daemon/LocalChat.js"
import { factor } from "./factor.ts"

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
  /**
   * Holds every download until `release` is called. `reached` resolves when the first one arrives, which is a point
   * after the turn has counted its start and before its prompt reaches the model.
   */
  readonly holdDownloads: () => {
    readonly reached: Promise<void>
    readonly release: () => void
  }
  /** Holds every `getThread` until `release` is called, as a platform that is slow to answer does. */
  readonly holdThreads: () => { readonly release: () => void }
  /** The ids of the status messages chad has posted: the posts with the Stop button on them. */
  readonly statuses: () => ReadonlyArray<string>
  /** The URL of every link button chad has posted, oldest first. */
  readonly links: () => ReadonlyArray<string>
  /** Clicks a button on a message as a user, and gives the daemon's answer to the click. */
  readonly click: (
    messageId: string,
    id: string,
    userId: string,
  ) => Effect.Effect<
    ChatInteraction.ClickReply | ChatInteraction.Late,
    ChatTest.NoSuchElement
  >
  /**
   * Clicks a button that opens a form as `clicker`, and submits the form it opened with `values` as `submitter`. It
   * gives the daemon's answer to the click and, when the click opened a form, to the submit.
   */
  readonly submit: (
    messageId: string,
    id: string,
    users: { readonly clicker: string; readonly submitter: string },
    values: Readonly<Record<string, string>>,
  ) => Effect.Effect<
    {
      readonly clicked: ChatInteraction.ClickReply | ChatInteraction.Late
      readonly submitted:
        ChatInteraction.SubmitReply | ChatInteraction.Late | undefined
    },
    ChatTest.NoSuchElement
  >
  /** Types a slash command in a thread as a user, and gives the daemon's answer to it. */
  readonly command: (
    thread: ChatThread.ChatThread,
    id: string,
    userId: string,
    text?: string,
  ) => Effect.Effect<ChatInteraction.CommandReply | ChatInteraction.Late>
  /** The number of writes the daemon has made to the chat. */
  readonly writes: () => number
  /** Resolves once the daemon has made more writes than `seen`. */
  readonly written: (seen: number) => Effect.Effect<void>
  /** The chat Layer of a daemon in the same process, with no socket in between. */
  readonly layer: Layer.Layer<
    never,
    never,
    ChatAdapter.Registry | ChatHandler.ChatHandler | ChatInteraction.Handler
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
        // Discord's floor between two writes, scaled as the daemon's own lengths are, so that an answer of five parts
        // is not paced by seconds.
        limits: {
          ...discord.limits,
          minWriteInterval: Duration.times(
            discord.limits.minWriteInterval,
            factor,
          ),
        },
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
    let held:
      | { readonly reach: () => void; readonly released: Promise<void> }
      | undefined
    const holdDownloads = () => {
      let reach = () => {}
      let release = () => {}
      const reached = new Promise<void>((resolve) => (reach = resolve))
      const released = new Promise<void>((resolve) => (release = resolve))
      held = { reach, released }
      return {
        reached,
        release: () => {
          held = undefined
          release()
        },
      }
    }
    let threads: Promise<void> | undefined
    const holdThreads = () => {
      let release = () => {}
      threads = new Promise<void>((resolve) => (release = resolve))
      return {
        release: () => {
          threads = undefined
          release()
        },
      }
    }
    const adapter: ChatAdapter.ChatAdapter = {
      ...inner,
      getThread: (thread) =>
        Effect.suspend(() => {
          const gate = threads
          return gate === undefined ? Effect.void : Effect.promise(() => gate)
        }).pipe(Effect.andThen(inner.getThread(thread))),
      download: (thread, attachment, options) =>
        Stream.unwrap(
          Effect.suspend(() => {
            const gate = held
            if (gate === undefined) return Effect.void
            gate.reach()
            return Effect.promise(() => gate.released)
          }).pipe(Effect.as(inner.download(thread, attachment, options))),
        ),
      post: (thread, content) =>
        wrote(
          "post",
          inner.post(thread, content).pipe(
            Effect.tap((posted) =>
              Effect.sync(() => {
                if (
                  content.actions?.some(
                    (action) =>
                      action._tag === "Button" && action.id === "stop-turn",
                  )
                ) {
                  statuses.add(posted.id)
                }
                for (const action of content.actions ?? [])
                  if (action._tag === "LinkButton") links.push(action.url)
              }),
            ),
          ),
        ),
      edit: (thread, id, content) =>
        wrote("edit", inner.edit(thread, id, content)),
      delete: (thread, id) => wrote("delete", inner.delete(thread, id)),
    }

    const statuses = new Set<string>()
    const links: Array<string> = []
    let interactions: ChatInteraction.Handler["Service"] | undefined
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
      holdDownloads,
      holdThreads,
      statuses: () => [...statuses],
      links: () => links,
      click: Effect.fnUntraced(function* (messageId, id, userId) {
        const event = yield* chat.click(messageId, id, { userId })
        if (event._tag !== "ButtonClicked" || interactions === undefined) {
          return yield* Effect.die(new Error("no daemon takes the click"))
        }
        return yield* chat
          .interact(event)
          .pipe(Effect.provideService(ChatInteraction.Handler, interactions))
      }),
      submit: Effect.fnUntraced(function* (messageId, id, users, values) {
        const handler = interactions
        const event = yield* chat.click(messageId, id, {
          userId: users.clicker,
        })
        if (event._tag !== "ButtonClicked" || handler === undefined) {
          return yield* Effect.die(new Error("no daemon takes the click"))
        }
        const clicked = yield* chat
          .interact(event)
          .pipe(Effect.provideService(ChatInteraction.Handler, handler))
        if (clicked._tag !== "OpenModal") {
          return { clicked, submitted: undefined }
        }
        const submit = yield* chat.submit(event, clicked, values, {
          userId: users.submitter,
        })
        const submitted = yield* chat
          .interact(submit)
          .pipe(Effect.provideService(ChatInteraction.Handler, handler))
        return { clicked, submitted }
      }),
      command: Effect.fnUntraced(function* (thread, id, userId, text) {
        const handler = interactions
        if (handler === undefined) {
          return yield* Effect.die(new Error("no daemon takes the command"))
        }
        const event = yield* chat.command(thread, id, { userId, text })
        return yield* chat
          .interact(event)
          .pipe(Effect.provideService(ChatInteraction.Handler, handler))
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
          interactions = yield* ChatInteraction.Handler
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
              // event whose sequence was not stored. The finalizer runs after the handler is detached.
              const gone = yield* Deferred.make<void>()
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(gone, undefined),
              )
              yield* attach({
                handle: Effect.fnUntraced(function* (event) {
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
