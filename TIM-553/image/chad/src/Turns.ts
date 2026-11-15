// Stand-in for the plugin API's Turns module.
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

export class Turns extends Context.Service<Turns, {
  readonly start: (options: { readonly session: string; readonly prompt: string }) => Effect.Effect<void>
}>()("chad/Turns") {}
