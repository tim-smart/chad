import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import {
  ChatAdapter,
  ChatError,
  ChatEvent,
  ChatHandler,
  ChatInteraction,
  ChatMessage,
  ChatThread,
  ChatUi,
} from "effect/chat"
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"

/**
 * The `local` connection kind. Its chat platform runs outside the daemon and listens at `run/local.sock`, and the
 * daemon holds only this client, which forwards each adapter operation over effect RPC. The platform itself is in the
 * repository's test support and never in the image.
 */

const Thread = ChatThread.ChatThread
const Actions = Schema.optional(Schema.Array(ChatUi.Action))

const File = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  content: Schema.Uint8Array,
})

const Posted = Schema.Struct({
  id: Schema.String,
  thread: Thread,
  timestamp: Schema.DateTimeUtcFromMillis,
})

const ThreadInfo = Schema.Struct({
  thread: Thread,
  kind: ChatEvent.ThreadKind,
  name: Schema.optional(Schema.String),
  topic: Schema.optional(Schema.String),
  parent: Schema.optional(Thread),
  createdAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  raw: Schema.Json,
})

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isBot: Schema.Boolean,
  isSelf: Schema.Boolean,
  raw: Schema.Json,
})

/** A descriptor without `measure`, which is a function and stays on each side. Both sides count code points. */
export const Descriptor = Schema.Struct({
  platform: Schema.String,
  capabilities: Schema.Array(ChatError.Capability),
  limits: Schema.Struct({
    messageLength: Schema.Number,
    filesPerMessage: Schema.Number,
    uploadBytes: Schema.Number,
    minWriteInterval: Schema.DurationFromMillis,
    streamLength: Schema.optional(Schema.Number),
    streamAge: Schema.optional(Schema.DurationFromMillis),
    actionsPerMessage: Schema.optional(Schema.Number),
    actionDataLength: Schema.optional(Schema.Number),
    modalMetadataLength: Schema.optional(Schema.Number),
    modalFields: Schema.optional(Schema.Number),
    followUpAge: Schema.optional(Schema.DurationFromMillis),
  }),
})

/** The length of a message on the local platform, which is its count of code points, as on Discord. */
export const measure = (markdown: string) => Array.from(markdown).length

const op = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
>(
  tag: Tag,
  payload: Payload,
  success: Success,
) => Rpc.make(tag, { payload, success, error: ChatError.ChatError })

/** The adapter's operations, and the two requests that carry inbound events to the daemon. */
export class Rpcs extends RpcGroup.make(
  Rpc.make("descriptor", { success: Descriptor }),
  op(
    "post",
    {
      thread: Thread,
      markdown: Schema.String,
      replyTo: Schema.optional(ChatMessage.ReplyTo),
      files: Schema.optional(Schema.Array(File)),
      actions: Actions,
    },
    Posted,
  ),
  op(
    "edit",
    {
      thread: Thread,
      messageId: Schema.String,
      markdown: Schema.String,
      actions: Actions,
    },
    Schema.Void,
  ),
  op("delete", { thread: Thread, messageId: Schema.String }, Schema.Void),
  op(
    "fetchMessage",
    { thread: Thread, messageId: Schema.String },
    ChatMessage.ChatMessage,
  ),
  Rpc.make("history", {
    payload: {
      thread: Thread,
      direction: Schema.Literals(["backward", "forward"]),
      from: Schema.optional(Schema.String),
    },
    success: ChatMessage.ChatMessage,
    error: ChatError.ChatError,
    stream: true,
  }),
  Rpc.make("download", {
    payload: {
      thread: Thread,
      attachment: ChatMessage.Attachment,
      maxBytes: Schema.Number,
    },
    success: Schema.Uint8Array,
    error: ChatError.ChatError,
    stream: true,
  }),
  op(
    "startThread",
    {
      thread: Thread,
      messageId: Schema.String,
      name: Schema.optional(Schema.String),
    },
    Thread,
  ),
  op("getThread", { thread: Thread }, ThreadInfo),
  op("opener", { thread: Thread }, Schema.NullOr(ChatMessage.ChatMessage)),
  op("getUser", { id: Schema.String, in: Schema.optional(Thread) }, User),
  op(
    "followUp",
    {
      deferred: ChatInteraction.Defer,
      markdown: Schema.String,
      actions: Actions,
    },
    Schema.Void,
  ),
  /** The inbound events, each with the id that `ack` answers. */
  Rpc.make("events", {
    success: Schema.Struct({ id: Schema.String, event: ChatEvent.ChatEvent }),
    stream: true,
  }),
  /** Tells the platform whether the daemon accepted an event. */
  Rpc.make("ack", {
    payload: { id: Schema.String, accepted: Schema.Boolean },
  }),
) {}

/**
 * The adapter client. It registers its adapter once the platform has answered with its descriptor, and until then it
 * does nothing but try again, so a daemon with a `local` connection boots whether or not a platform is listening.
 */
export const layerClient = (path: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(Rpcs)
      const registry = yield* ChatAdapter.Registry
      const handler = yield* ChatHandler.ChatHandler

      const connect = Effect.gen(function* () {
        const described = yield* client.descriptor()
        // A request that could not reach the platform is a transport failure of the chat operation. The request may
        // have landed all the same, so a write is not safe to send again.
        const unreachable = (name: string) => (cause: RpcClientError) =>
          new ChatError.ChatError({
            platform: described.platform,
            op: name,
            reason: new ChatError.Transport({ retry: "uncertain", cause }),
          })
        const call =
          (name: string) =>
          <A>(effect: Effect.Effect<A, ChatError.ChatError | RpcClientError>) =>
            Effect.catchTag(effect, "RpcClientError", (error) =>
              Effect.fail(unreachable(name)(error)),
            )
        const stream =
          (name: string) =>
          <A>(self: Stream.Stream<A, ChatError.ChatError | RpcClientError>) =>
            Stream.catchTag(self, "RpcClientError", (error) =>
              Stream.fail(unreachable(name)(error)),
            )
        yield* registry.register({
          descriptor: {
            platform: described.platform,
            capabilities: new Set(described.capabilities),
            measure,
            limits: described.limits,
          },
          post: (thread, content) =>
            client.post({ thread, ...content }).pipe(call("post")),
          edit: (thread, messageId, content) =>
            client.edit({ thread, messageId, ...content }).pipe(call("edit")),
          delete: (thread, messageId) =>
            client.delete({ thread, messageId }).pipe(call("delete")),
          fetchMessage: (thread, messageId) =>
            client
              .fetchMessage({ thread, messageId })
              .pipe(call("fetchMessage")),
          history: (thread, options) =>
            client.history({ thread, ...options }).pipe(stream("history")),
          download: (thread, attachment, options) =>
            client
              .download({ thread, attachment, maxBytes: options.maxBytes })
              .pipe(stream("download")),
          startThread: (thread, messageId, options) =>
            client
              .startThread({ thread, messageId, name: options?.name })
              .pipe(call("startThread")),
          getThread: (thread) =>
            client.getThread({ thread }).pipe(call("getThread")),
          opener: (thread) =>
            client
              .opener({ thread })
              .pipe(Effect.map(Option.fromNullOr), call("opener")),
          getUser: (id, options) =>
            client.getUser({ id, in: options?.in }).pipe(call("getUser")),
          followUp: (deferred, content) =>
            client.followUp({ deferred, ...content }).pipe(call("followUp")),
        })
        yield* client.events().pipe(
          Stream.runForEach(({ id, event }) =>
            handler.handle(event).pipe(
              Effect.as(true),
              Effect.catchTag("NotAccepted", () => Effect.succeed(false)),
              Effect.flatMap((accepted) => client.ack({ id, accepted })),
            ),
          ),
        )
      })

      yield* connect.pipe(Effect.ignore, Effect.forever, Effect.forkScoped)
    }),
  ).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket({ retryTransientErrors: true }),
    ),
    Layer.provide(NodeSocket.layerNet({ path })),
    Layer.provide(RpcSerialization.layerNdjson),
    // The socket is opened when the first request runs, so building the Layer cannot fail.
    Layer.orDie,
  )
