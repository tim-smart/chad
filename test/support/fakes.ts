// The one interface through which a scenario reaches the chat fake and the model fake. It has two implementations.
// `direct` holds the fakes in the scenario's own process. `remote` goes over a test-only RPC group that is served
// next to the adapter operations, which is how a scenario reaches fakes that run in another process or container.
import { Effect, Layer, Schema, Scope } from "effect"
import { ChatEvent, ChatMessage, ChatThread } from "effect/chat"
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import type { Socket } from "effect/socket"
import type * as Model from "./model.ts"
import type { Platform } from "./platform.ts"

export interface UserMessage {
  readonly text: string
  readonly authorId?: string | undefined
  readonly isBot?: boolean | undefined
  readonly mentionsSelf?: boolean | undefined
  readonly files?: ReadonlyArray<File> | undefined
}

/** A file on a user's message. */
export interface File {
  readonly name: string
  readonly contentType: string
  readonly content: Uint8Array
}

export interface Fakes {
  readonly chat: {
    readonly makeThread: (
      kind?: ChatEvent.ThreadKind,
    ) => Promise<ChatThread.ChatThread>
    /** Puts a user's message in the thread and gives its event, which is not delivered yet. */
    readonly userPosts: (
      thread: ChatThread.ChatThread,
      message: UserMessage,
    ) => Promise<ChatEvent.ChatEvent>
    /** Hands an event to the daemon and says whether the daemon accepted it. */
    readonly deliver: (event: ChatEvent.ChatEvent) => Promise<boolean>
    readonly messages: (
      thread: ChatThread.ChatThread,
    ) => Promise<ReadonlyArray<ChatMessage.ChatMessage>>
    /** Waits until chad has posted `count` messages in the thread, and gives them. */
    readonly answers: (
      thread: ChatThread.ChatThread,
      count: number,
    ) => Promise<ReadonlyArray<ChatMessage.ChatMessage>>
  }
  readonly model: {
    readonly script: (replies: ReadonlyArray<Model.Reply>) => Promise<void>
    readonly release: (index: number) => Promise<void>
    readonly calls: () => Promise<ReadonlyArray<Model.Call>>
    /** Waits until the model fake has received `count` calls, and gives them. */
    readonly received: (count: number) => Promise<ReadonlyArray<Model.Call>>
  }
}

export const direct = (platform: Platform, model: Model.FakeModel): Fakes => {
  const own = (thread: ChatThread.ChatThread) =>
    Effect.map(platform.chat.messages(thread), (messages) =>
      messages.filter((message) => message.author.isSelf),
    )
  const answers = (
    thread: ChatThread.ChatThread,
    count: number,
  ): Effect.Effect<ReadonlyArray<ChatMessage.ChatMessage>> =>
    Effect.gen(function* () {
      const seen = platform.writes()
      const posted = yield* own(thread)
      if (posted.length >= count) return posted
      yield* platform.written(seen)
      return yield* answers(thread, count)
    })
  return {
    chat: {
      makeThread: (kind) => Effect.runPromise(platform.chat.makeThread(kind)),
      userPosts: (thread, message) =>
        Effect.runPromise(platform.chat.userPosts(thread, message)),
      deliver: (event) =>
        Effect.runPromise(
          platform.deliver(event).pipe(
            Effect.as(true),
            Effect.catchTag("NotAccepted", () => Effect.succeed(false)),
          ),
        ),
      messages: (thread) => Effect.runPromise(platform.chat.messages(thread)),
      answers: (thread, count) => Effect.runPromise(answers(thread, count)),
    },
    model: {
      script: async (replies) => model.script(replies),
      release: async (index) => model.release(index),
      calls: async () => model.calls(),
      received: (count) => model.received(count),
    },
  }
}

const Thread = ChatThread.ChatThread
const Messages = Schema.Array(ChatMessage.ChatMessage)

const Reply = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(
    Schema.Struct({ name: Schema.String, arguments: Schema.Json }),
  ),
  status: Schema.optionalKey(Schema.Number),
  hold: Schema.optionalKey(Schema.Boolean),
  usage: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Number,
      output: Schema.Number,
      cached: Schema.optionalKey(Schema.Number),
      reasoning: Schema.optionalKey(Schema.Number),
    }),
  ),
})

const Call = Schema.Struct({
  index: Schema.Number,
  path: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Json,
})

/** The test-only requests. Nothing in the product knows this group. */
export class Rpcs extends RpcGroup.make(
  Rpc.make("makeThread", {
    payload: { kind: Schema.optional(ChatEvent.ThreadKind) },
    success: Thread,
  }),
  Rpc.make("userPosts", {
    payload: {
      thread: Thread,
      text: Schema.String,
      authorId: Schema.optional(Schema.String),
      isBot: Schema.optional(Schema.Boolean),
      mentionsSelf: Schema.optional(Schema.Boolean),
      files: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            contentType: Schema.String,
            content: Schema.Uint8Array,
          }),
        ),
      ),
    },
    success: ChatEvent.ChatEvent,
  }),
  Rpc.make("deliver", {
    payload: { event: ChatEvent.ChatEvent },
    success: Schema.Boolean,
  }),
  Rpc.make("messages", { payload: { thread: Thread }, success: Messages }),
  Rpc.make("answers", {
    payload: { thread: Thread, count: Schema.Number },
    success: Messages,
  }),
  Rpc.make("modelScript", { payload: { replies: Schema.Array(Reply) } }),
  Rpc.make("modelRelease", { payload: { index: Schema.Number } }),
  Rpc.make("modelCalls", { success: Schema.Array(Call) }),
  Rpc.make("modelReceived", {
    payload: { count: Schema.Number },
    success: Schema.Array(Call),
  }),
) {}

const encoded = (calls: ReadonlyArray<Model.Call>) =>
  calls.map((call) => ({ ...call, body: call.body as Schema.Json }))

/** Serves the test-only requests from the fakes of this process. */
export const handlers = (fakes: Fakes) =>
  Rpcs.toLayer({
    makeThread: ({ kind }) => Effect.promise(() => fakes.chat.makeThread(kind)),
    userPosts: ({ thread, ...message }) =>
      Effect.promise(() => fakes.chat.userPosts(thread, message)),
    deliver: ({ event }) => Effect.promise(() => fakes.chat.deliver(event)),
    messages: ({ thread }) => Effect.promise(() => fakes.chat.messages(thread)),
    answers: ({ thread, count }) =>
      Effect.promise(() => fakes.chat.answers(thread, count)),
    modelScript: ({ replies }) =>
      Effect.promise(() => fakes.model.script(replies)),
    modelRelease: ({ index }) =>
      Effect.promise(() => fakes.model.release(index)),
    modelCalls: () => Effect.promise(() => fakes.model.calls().then(encoded)),
    modelReceived: ({ count }) =>
      Effect.promise(() => fakes.model.received(count).then(encoded)),
  })

/** The fakes of another process, reached through a client of the test-only requests. */
export const remote = (
  client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof Rpcs>, RpcClientError>,
): Fakes => {
  const run = <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.runPromise(Effect.orDie(effect))
  return {
    chat: {
      makeThread: (kind) => run(client.makeThread({ kind })),
      userPosts: (thread, message) =>
        run(client.userPosts({ thread, ...message })),
      deliver: (event) => run(client.deliver({ event })),
      messages: (thread) => run(client.messages({ thread })),
      answers: (thread, count) => run(client.answers({ thread, count })),
    },
    model: {
      script: (replies) => run(client.modelScript({ replies })),
      release: (index) => run(client.modelRelease({ index })),
      calls: () => run(client.modelCalls()),
      received: (count) => run(client.modelReceived({ count })),
    },
  }
}

/**
 * The fakes at the far end of a socket, which is how a scenario reaches the ones behind `run/local.sock`. The client
 * and its socket live as long as the scope.
 */
export const over = <E>(
  socket: Layer.Layer<Socket.Socket, E>,
  scope: Scope.Scope,
): Promise<Fakes> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const protocol = yield* Layer.buildWithScope(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(socket),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        scope,
      )
      const client = yield* RpcClient.make(Rpcs).pipe(
        Effect.provideContext(protocol),
        Scope.provide(scope),
      )
      return remote(client)
    }),
  )
