/**
 * The values chad hands to hooks and tool handlers: sessions, turns and how they ended.
 */
import type { Prompt } from "effect/ai"
import type { ChatMessage, ChatThread } from "effect/chat"
import { Context, type DateTime, type Effect, type Option } from "effect"

/**
 * One conversation. A chat thread has one session at a time, and a reset gives
 * the thread a new session with a new id.
 */
export interface Session {
  /** The session's id. A reset gives the thread a session with a new id. */
  readonly id: string
  /** `{ platform, id }`, for example `{ platform: "discord", id: "<channel id>" }`. */
  readonly thread: ChatThread.ChatThread
  /** The kind of chat thread the session is in. */
  readonly kind: "direct" | "channel" | "thread"
  /**
   * The absolute path of the directory the session's agent works in. Its
   * scripts run there, so a relative path the agent names is relative to it.
   */
  readonly directory: string
}

/** What started a turn. A plugin started it when there is no chat message behind it. */
export type Origin =
  | {
      readonly _tag: "Message"
      /** Carries `author: { id, name?, isBot }`, `text`, `timestamp` and `attachments`. */
      readonly message: ChatMessage.ChatMessage
    }
  | {
      readonly _tag: "Plugin"
      /** The name of the plugin that started the turn. */
      readonly plugin: string
      /** What the plugin called this turn, for example a cron job's name. */
      readonly label: string
      /**
       * The timer's name and the time the run was due, set when
       * `Turns.schedule` started the turn. Absent for a turn started with
       * `Turns.start`.
       */
      readonly timer?:
        | {
            /** The timer's name. */
            readonly name: string
            /** The time the run was due. */
            readonly scheduledAt: DateTime.Utc
          }
        | undefined
      /**
       * The name of the timer whose runs the turn waited its place among,
       * set when `Turns.queue` was given `timer`.
       */
      readonly queuedFor?: string | undefined
    }

/** One run of the agent in a session, from the prompt that starts it to its outcome. */
export interface Turn {
  /** The turn's id. A turn that is resumed after a restart keeps it. */
  readonly id: string
  /** The session the turn runs in. */
  readonly session: Session
  /** What started the turn. */
  readonly origin: Origin
  /**
   * The text chad sends the model to start the turn, before any plugin adds
   * context to it. It can differ from what the owner typed: chad adds lines
   * for attachments, and a resumed turn starts from a restart note. A plugin
   * that wants the owner's words reads `origin.message.text`.
   */
  readonly prompt: string
  /** When the turn started. */
  readonly startedAt: DateTime.Utc
  /**
   * True when this turn was cut off by a restart and is being run again. The
   * id and the origin are those of the first attempt.
   */
  readonly resumed: boolean
}

/**
 * Why a turn failed. A closed set. The message chad posts for each case is
 * not part of this value.
 */
export type FailedReason =
  | {
      /** The turn's thread is gone. */
      readonly _tag: "ThreadGone"
    }
  | {
      /**
       * The model request failed, kept failing after the retries, or the model
       * did not answer for 15 minutes.
       */
      readonly _tag: "ModelError"
      /**
       * The reason tag of the `AiError`, or `TurnTimeout` when chad ended the
       * turn because the model did not answer for 15 minutes.
       */
      readonly reason: string
      /** The error's message. */
      readonly message: string
      /** How many retries were made before the turn ended. */
      readonly retries: number
    }
  | {
      /** The provider said the plan's usage limit is reached. */
      readonly _tag: "UsageLimit"
      /** When the limit resets. Absent when the provider's error carried no time. */
      readonly resetsAt?: DateTime.Utc | undefined
    }
  | {
      /** A model login that the turn started, or was waiting on, did not succeed. */
      readonly _tag: "LoginFailed"
      /**
       * `TimedOut`, one of clanka's `CodexAuthError` reasons, or `SignInNeeded` when the Antigravity sign-in is
       * missing and only `chad login antigravity` makes one.
       */
      readonly reason:
        | "TimedOut"
        | "DeviceFlowFailed"
        | "TokenExchangeFailed"
        | "RefreshFailed"
        | "SignInNeeded"
    }
  | {
      /**
       * A turn with no owner present, on a chad that is logged out with no
       * login pending. It ends at once.
       */
      readonly _tag: "LoggedOut"
    }
  | {
      /** A resumed turn that chad stopped retrying. */
      readonly _tag: "GaveUp"
    }
  | {
      /** Any other defect in chad or clanka. A full disk is one. */
      readonly _tag: "Internal"
      /** The defect's message. */
      readonly message: string
    }

/**
 * How a turn ended. An answer that is exactly `[SILENT]` is `Answered` with
 * that text. An answer that could not be posted to a thread that still
 * exists is `Answered` too. A caller of `Turns.start` that chad answers from
 * the record of a turn that had already ended gets `Answered` with an empty
 * text.
 */
export type Outcome =
  | {
      readonly _tag: "Answered"
      /** The answer's text. */
      readonly text: string
    }
  | {
      readonly _tag: "Failed"
      /** Why the turn failed. */
      readonly reason: FailedReason
    }
  | { readonly _tag: "Stopped" }

/** What an `afterTurn` hook receives. */
export interface TurnEnded {
  /** The turn that ended. */
  readonly turn: Turn
  /**
   * The owner's messages that steered the turn. A message that was still
   * waiting to steer when the turn was stopped or the session was reset was
   * dropped unread and is not here.
   */
  readonly steers: ReadonlyArray<ChatMessage.ChatMessage>
  /** How the turn ended. */
  readonly outcome: Outcome
  /** Everything this turn added to the session's history. */
  readonly appended: ReadonlyArray<Prompt.Message>
}

/** An open union. More cases may be added, so match with a default. */
export type SessionEvent =
  | {
      /** The owner reset the thread. `previous` is over and `session` replaces it. */
      readonly _tag: "Reset"
      /** The session that is over. */
      readonly previous: Session
      /** The session that replaces it. */
      readonly session: Session
    }
  | {
      /**
       * clanka replaced the history with a summary. The session id is unchanged.
       * Delivered once, after the turn in which it happened has ended and after
       * that turn's `afterTurn`.
       */
      readonly _tag: "Compacted"
      /** The session whose history was replaced. */
      readonly session: Session
    }

/**
 * Available inside a tool handler when the tool lists it in `dependencies`.
 * chad builds one clanka Agent per session and provides this to it. A
 * sub-agent shares the main agent's handlers, so a handler cannot tell which
 * of the two called it.
 */
export class CurrentSession extends Context.Service<
  CurrentSession,
  {
    /** The session the calling agent runs in. */
    readonly session: Session
    /** The turn that is running now. None when a background task outlives its turn. */
    readonly turn: Effect.Effect<Option.Option<Turn>>
  }
>()("chad/Session/CurrentSession") {}
