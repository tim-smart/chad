import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  PrimaryKey,
  Schema,
  Scope,
  Stream,
} from "effect"
import type { LanguageModel, Model as AiModel } from "effect/ai"
import {
  Chat,
  ChatEvent,
  ChatMarkdown,
  ChatMessage,
  ChatThread,
} from "effect/chat"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { Timings } from "../Timings.ts"
import { Chats } from "./Chats.ts"
import * as Logger from "./Logger.ts"
import { Volume } from "./Volume.ts"

/**
 * An owner's message, as the request cluster persists. Its primary key is the event's dedupe key, so an event that is
 * delivered again is dropped while cluster still holds the request.
 */
export class Message extends Schema.Class<Message>("chad/Session/Message")({
  key: Schema.String,
  /** The name of the chat connection the message arrived on, which is the one the session answers through. */
  connection: Schema.String,
  /** The whole chat message, in effect/chat's own encoded form. */
  message: ChatMessage.ChatMessage,
  attachments: Schema.Array(Schema.String),
}) {
  static fromEvent(event: ChatEvent.MessageCreated, connection: string) {
    return new Message({
      key: ChatEvent.dedupeKey(event),
      connection,
      message: event.message,
      attachments: event.message.attachments.map((attachment) => attachment.id),
    })
  }
  [PrimaryKey.symbol]() {
    return this.key
  }
}

/** How a request ended. The entity posts to chat itself, so the reply carries nothing else. */
export const Outcome = Schema.Literals(["answered", "failed"])

/** One session thread. The entity id is the thread string `ChatThread.toString(thread)`. */
export const Session = Entity.make("Session", [
  Rpc.make("message", { payload: Message, success: Outcome }).annotate(
    ClusterSchema.Persisted,
    true,
  ),
])

/** The model a turn runs on, when the environment names one. */
export class Model extends Context.Service<
  Model,
  Option.Option<
    Layer.Layer<
      LanguageModel.LanguageModel | AiModel.ProviderName | AiModel.ModelName
    >
  >
>()("chad/SessionEntity/Model") {}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const timings = yield* Timings
    return Session.toLayer(
      Effect.gen(function* () {
        const address = yield* Entity.CurrentAddress
        const thread = Option.getOrThrow(
          ChatThread.fromString(address.entityId),
        )
        const scope = yield* Effect.scope
        const sql = yield* SqlClient.SqlClient
        const volume = yield* Volume
        const model = yield* Model
        const chats = yield* Chats
        let agent: Agent.Agent | undefined
        // The session id, which is the `session` key of the session's log lines once the session has started.
        let session: string | undefined

        // The session's Agent, made on the first message of an activation. It works in the session's own directory.
        const start = Effect.fnUntraced(function* () {
          if (agent !== undefined) return agent
          const key = ChatThread.toString(thread)
          const rows = yield* sql<{
            id: string
          }>`SELECT id FROM sessions WHERE thread = ${key} ORDER BY created_at DESC, rowid DESC LIMIT 1`
          let id = rows[0]?.id
          if (id === undefined) {
            id = randomUUID()
            yield* sql`INSERT INTO sessions (id, thread, created_at) VALUES (${id}, ${key}, ${Date.now()})`
          }
          session = id
          const directory = join(volume.sessions, id)
          mkdirSync(directory, { recursive: true })
          const executor = yield* Layer.buildWithScope(
            AgentExecutor.layerLocal({ directory }),
            scope,
          )
          agent = yield* Agent.make.pipe(
            Effect.provideContext(executor),
            Effect.provideService(Scope.Scope, scope),
          )
          return agent
        })

        // One turn. The answer is the clean final text, which arrives when clanka's stream ends with AgentFinished.
        const turn = Effect.fnUntraced(function* (request: Message) {
          const running = yield* start()
          const layer = yield* Effect.fromOption(model)
          const answer = yield* running
            .send({ prompt: request.message.text })
            .pipe(
              Effect.flatMap(Stream.runDrain),
              Effect.as(""),
              Effect.catchTag("AgentFinished", (finished) =>
                Effect.succeed(finished.summary),
              ),
              Effect.scoped,
              Effect.provide(layer),
            )
          // The answer goes out through the connection the message arrived on.
          const chat = yield* chats.get(request.connection)
          yield* ChatMarkdown.post(thread, answer).pipe(
            Effect.provideService(Chat.Chat, chat),
          )
        })

        return Session.of({
          message: ({ payload }) =>
            turn(payload).pipe(
              Effect.as("answered" as const),
              Effect.catchCause((cause) =>
                Logger.event("turn.failed", "The turn failed", {
                  ...(session === undefined ? {} : { session }),
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as("failed" as const)),
              ),
            ),
        })
      }),
      { maxIdleTime: timings.sessionIdle },
    )
  }),
)
