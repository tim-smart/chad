// PROTOTYPE for TIM-530. Throwaway. Checks that plugin toolkits fit clanka's
// `loopTools` slot and that chad can provide CurrentSession per session.
import * as Agent from "clanka/Agent"
import type * as AgentExecutor from "clanka/AgentExecutor"
import { Tool, Toolkit } from "effect/ai"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { CurrentSession, type Session } from "./Session.ts"

const A = Toolkit.make(Tool.make("a", { description: "a", parameters: Schema.Struct({}), success: Schema.String, dependencies: [CurrentSession] }))
const B = Toolkit.make(Tool.make("b", { description: "b", parameters: Schema.Struct({}), success: Schema.String }))

// what two plugins registered
const handlersA = A.toLayer({ a: () => Effect.map(CurrentSession, (current) => current.session.id) })
const handlersB = B.toLayer({ b: () => Effect.succeed("b") })

// what chad does when it builds a session's Agent
const merged = Toolkit.merge(A, B)
export const buildAgent = (session: Session): Effect.Effect<Agent.Agent, never, Scope.Scope | AgentExecutor.AgentExecutor> =>
  Agent.makeWith({ loopTools: merged }).pipe(
    Effect.provide(Layer.mergeAll(handlersA, handlersB)),
    Effect.provide(Layer.succeed(CurrentSession, { session, turn: Effect.succeed(Option.none()) }))
  )
