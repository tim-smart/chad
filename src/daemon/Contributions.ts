import type { Context, Duration, Effect, Scope } from "effect"
import type { Toolkit } from "effect/ai"
import type { ChatInteraction } from "effect/chat"
import type { Session, SessionEvent, Turn, TurnEnded } from "../Session.ts"

/**
 * What one load of a plugin added to chad. Each contribution function of `chad/Plugin` pushes its part here while the
 * plugin's Layer builds, and the host reads it once the build is done. It rides on the `PluginContext` value under a
 * symbol that is no part of the plugin API, so a plugin file cannot reach it by a name it can import.
 */
export interface Contributions {
  readonly toolkits: Array<{
    readonly toolkit: Toolkit.Any
    /** The context the contribution was built in, which holds the toolkit's handlers. */
    readonly context: Context.Context<never>
  }>
  /** The `Plugin.interactions` handlers, each with its services provided and its value decoded. */
  readonly interactions: Array<ChatInteraction.Registered>
  readonly prompts: Array<Hook<Session, string>>
  readonly beforeTurn: Array<Hook<Turn, string | void>>
  readonly afterTurn: Array<Hook<TurnEnded, void>>
  readonly onSession: Array<Hook<SessionEvent, void>>
  /** The `Plugin.background` effects, which the host forks into the plugin's scope once the plugin is active. */
  readonly background: Array<
    (scope: Scope.Scope) => Effect.Effect<unknown, unknown>
  >
}

/** One registered hook, with the services it was built with, and the budget its plugin gave, if any. */
export interface Hook<A, B> {
  readonly run: (input: A) => Effect.Effect<B, unknown>
  readonly timeout: Duration.Duration | undefined
}

export const key: unique symbol = Symbol.for(
  "chad/Plugin/contributions",
) as never

export const empty = (): Contributions => ({
  toolkits: [],
  interactions: [],
  prompts: [],
  beforeTurn: [],
  afterTurn: [],
  onSession: [],
  background: [],
})

/** The contributions a `PluginContext` value carries. */
export const of = (context: object): Contributions => {
  const found = (context as { readonly [key]?: Contributions })[key]
  if (found === undefined) {
    throw new Error("this PluginContext was not made by chad")
  }
  return found
}
