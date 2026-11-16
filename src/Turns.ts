/**
 * The service a plugin uses to start a turn now or on a schedule.
 */
import type { ChatThread } from "effect/chat"
import { Context, type DateTime, type Effect } from "effect"
import type { Outcome } from "./Session.ts"

/** A scheduled run that chad holds for the calling plugin. */
export interface Timer {
  /** The name the plugin gave it. Names are scoped to the plugin. */
  readonly name: string
  /** One time, or a 5-field cron expression with an IANA timezone. */
  readonly schedule:
    | {
        /** The one time the turn runs. */
        readonly at: DateTime.Utc
      }
    | {
        /** A 5-field cron expression. */
        readonly cron: string
        /** The IANA timezone the expression is read in. */
        readonly timezone: string
      }
  /** The thread whose session the turn runs in. */
  readonly thread: ChatThread.ChatThread
  /** The prompt that starts the turn. */
  readonly prompt: string
  /** What the plugin called the turn. */
  readonly label: string
  /** A user id that chad mentions at the start of the answer in a server thread. */
  readonly mention?: string | undefined
  /** When the next run is due. Only the next run is ever stored. */
  readonly nextRun: DateTime.Utc
}

/**
 * How a plugin starts a turn on its own, now or on a schedule. To post
 * without the agent, a plugin uses effect/chat's `Chat` service directly.
 *
 * No call here has a typed error. `start` reports a turn that failed in its
 * `Outcome`. `start`, `queue`, `schedule` and `cancel` die with a defect
 * whose message says why when what they asked for cannot be saved, and
 * `start` dies with one too when it is called for the thread of the calling
 * tool's own turn. Inside a tool handler clanka returns that message to the
 * calling script.
 *
 * Every call here, made by a version that is not active yet, waits for the
 * activation. A call that the Layer build itself waits on therefore never
 * returns, and the load fails. Such a call belongs in `Plugin.background`.
 */
export class Turns extends Context.Service<
  Turns,
  {
    /**
     * Runs a turn in the thread's session and posts the answer there, the same
     * way an owner message would. Waits behind a turn that is already running
     * and never steers it. Hooks see it with `origin._tag === "Plugin"`.
     * Every call starts its own turn.
     *
     * The prompt has to say what started the turn and that nobody is there to
     * answer questions. chad adds no such line itself, and the agent reads it
     * to know that it must not apply changes unasked.
     *
     * An answer that is exactly `[SILENT]` is not posted, and the outcome is
     * `Answered` with that text. `mention` is a user id. chad puts that
     * mention at the start of the answer in a server thread and ignores it in
     * a direct message. A mention of an id that is not an owner's is dropped.
     * The message for a failed turn starts with the mention too.
     *
     * Called from a tool handler for the thread of the handler's own turn, it
     * fails at once, because that turn queues behind the turn that called the
     * tool and a call that waited would deadlock. A tool handler uses `queue`
     * there. A fiber that is waiting when the plugin is reloaded loses the
     * outcome while the turn carries on, so a plugin that needs the outcome
     * reads it in `afterTurn`. Called by a version that is not active yet,
     * it waits for the activation.
     *
     * When the request cannot be saved, it fails with a defect, no turn
     * starts and no `afterTurn` hook runs.
     */
    readonly start: (options: {
      /** The thread whose session the turn runs in. */
      readonly thread: ChatThread.ChatThread
      /**
       * The prompt that starts the turn. It has to say what started the turn
       * and that nobody is there to answer questions.
       */
      readonly prompt: string
      /** What the plugin calls the turn. Hooks see it on `origin.label`. */
      readonly label: string
      /** A user id that chad mentions at the start of the answer in a server thread. */
      readonly mention?: string | undefined
    }) => Effect.Effect<Outcome>
    /**
     * Queues a turn the way `start` starts one and returns once the request
     * is saved, without waiting for the turn. A tool handler uses it to queue
     * a turn in its own thread. A plugin that needs the outcome reads it in
     * `afterTurn`.
     *
     * The prompt has to say what started the turn and that nobody is there to
     * answer questions, as for `start`.
     */
    readonly queue: (options: {
      /** The thread whose session the turn runs in. */
      readonly thread: ChatThread.ChatThread
      /**
       * The prompt that starts the turn. It has to say what started the turn
       * and that nobody is there to answer questions.
       */
      readonly prompt: string
      /** What the plugin calls the turn. Hooks see it on `origin.label`. */
      readonly label: string
      /** A user id that chad mentions at the start of the answer in a server thread. */
      readonly mention?: string | undefined
    }) => Effect.Effect<void>
    /**
     * Schedules a turn that survives a restart, once at `at` or repeating on
     * a 5-field cron expression in an IANA timezone. Scheduling under a name
     * that already has a run replaces it. The turn is started the way `start`
     * starts one, and hooks see the timer's name and the scheduled time on
     * `origin.timer`.
     *
     * chad stores only the next run. A run that came due while chad was down,
     * or while this plugin was not loaded, fires once when it can, however
     * many runs were missed. The next run of a repeating timer is saved after
     * the turn ends, so two runs of one timer never overlap.
     *
     * A cron expression follows the daylight saving behaviour of Effect's
     * `Cron`. A time inside a skipped hour runs once, at the first instant
     * after the gap. A time inside a repeated hour runs once, on the first
     * occurrence.
     *
     * The prompt has to say what started the turn and that nobody is there to
     * answer questions, as for `start`.
     */
    readonly schedule: (
      options: (
        | {
            /** The timer's name, scoped to the plugin. */
            readonly name: string
            /** The one time the turn runs. */
            readonly at: DateTime.Utc
          }
        | {
            /** The timer's name, scoped to the plugin. */
            readonly name: string
            /** A 5-field cron expression. */
            readonly cron: string
            /** The IANA timezone the expression is read in. */
            readonly timezone: string
          }
      ) & {
        /** The thread whose session the turn runs in. */
        readonly thread: ChatThread.ChatThread
        /**
         * The prompt that starts the turn. It has to say what started the turn
         * and that nobody is there to answer questions.
         */
        readonly prompt: string
        /** What the plugin calls the turn. Hooks see it on `origin.label`. */
        readonly label: string
        /** A user id that chad mentions at the start of the answer in a server thread. */
        readonly mention?: string | undefined
      },
    ) => Effect.Effect<void>
    /**
     * Cancels this plugin's timer of that name. A run that has already
     * started carries on, and no further run is saved for it.
     */
    readonly cancel: (name: string) => Effect.Effect<void>
    /** The calling plugin's timers, and no other plugin's. */
    readonly scheduled: () => Effect.Effect<ReadonlyArray<Timer>>
  }
>()("chad/Turns") {}
