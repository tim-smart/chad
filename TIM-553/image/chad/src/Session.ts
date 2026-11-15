// Stand-in for the plugin API's Session module.
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

export class Session extends Context.Service<Session, {
  readonly id: string
  readonly send: (text: string) => Effect.Effect<void>
}>()("chad/Session") {}
