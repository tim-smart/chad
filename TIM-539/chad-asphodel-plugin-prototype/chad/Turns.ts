// PROTOTYPE for TIM-530. Throwaway. Types only, no implementation.
import type { ChatThread } from "effect/chat"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { Outcome } from "./Session.ts"

/**
 * How a plugin starts a turn on its own. To post without the agent, a plugin
 * uses effect/chat's `Chat` service directly.
 */
export class Turns extends Context.Service<
  Turns,
  {
    /**
     * Runs a turn in the thread's session and posts the answer there, the same
     * way an owner message would. Waits behind a turn that is already running.
     * Hooks see it with `origin._tag === "Plugin"`.
     */
    readonly start: (options: {
      readonly thread: ChatThread.ChatThread
      readonly prompt: string
      readonly label: string
    }) => Effect.Effect<Outcome>
  }
>()("chad/Turns") {}
