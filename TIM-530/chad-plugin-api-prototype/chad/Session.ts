// PROTOTYPE for TIM-530. Throwaway. Types only, no implementation.
import type * as Prompt from "effect/ai/Prompt"
import type { ChatMessage, ChatThread } from "effect/chat"
import * as Context from "effect/Context"
import type * as DateTime from "effect/DateTime"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"

/**
 * One conversation. A chat thread has one session at a time, and a reset gives
 * the thread a new session with a new id.
 */
export interface Session {
  readonly id: string
  /** `{ platform, id }`, for example `{ platform: "discord", id: "<channel id>" }`. */
  readonly thread: ChatThread.ChatThread
  readonly kind: "direct" | "channel" | "thread"
}

/** What started a turn. A plugin started it when there is no chat message behind it. */
export type Origin =
  | {
      readonly _tag: "Message"
      /** Carries `author: { id, name?, isBot }`, `timestamp` and `attachments`. */
      readonly message: ChatMessage.ChatMessage
    }
  | {
      readonly _tag: "Plugin"
      readonly plugin: string
      /** What the plugin called this turn, for example a cron job's name. */
      readonly label: string
    }

export interface Turn {
  readonly id: string
  readonly session: Session
  readonly origin: Origin
  /** The text that starts the turn, before any plugin adds context to it. */
  readonly prompt: string
  readonly startedAt: DateTime.Utc
}

export type Outcome =
  | { readonly _tag: "Answered"; readonly text: string }
  | { readonly _tag: "Failed"; readonly reason: string }
  | { readonly _tag: "Stopped" }

export interface TurnEnded {
  readonly turn: Turn
  /** Messages the owner sent while the turn was running. */
  readonly steers: ReadonlyArray<ChatMessage.ChatMessage>
  readonly outcome: Outcome
  /** Everything this turn added to the session's history. */
  readonly appended: ReadonlyArray<Prompt.Message>
}

/** An open union. More cases may be added, so match with a default. */
export type SessionEvent =
  | {
      /** The owner reset the thread. `previous` is over and `session` replaces it. */
      readonly _tag: "Reset"
      readonly previous: Session
      readonly session: Session
    }
  | {
      /** clanka replaced the history with a summary. The session id is unchanged. */
      readonly _tag: "Compacted"
      readonly session: Session
    }

/**
 * Available inside a tool handler when the tool lists it in `dependencies`.
 * chad builds one clanka Agent per session and provides this to it.
 */
export class CurrentSession extends Context.Service<
  CurrentSession,
  {
    readonly session: Session
    /** The turn that is running now. None when a background task outlives its turn. */
    readonly turn: Effect.Effect<Option.Option<Turn>>
  }
>()("chad/Session/CurrentSession") {}
