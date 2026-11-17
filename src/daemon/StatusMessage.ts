import {
  type Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  Scope,
  Semaphore,
} from "effect"
import { ChatError, ChatInteraction, type ChatThread } from "effect/chat"
import * as Messages from "../Messages.ts"
import type { ChatService } from "./Chats.ts"
import type { Format } from "./Format.ts"

/**
 * The status message of a running turn: one message that chad posts when the turn starts,
 * edits in place as the agent acts, and removes when the turn ends. It carries the Stop button.
 *
 * The seam for what posts after it: the entity opens the status message with `open`, the steps of the turn add their
 * lines through `Lines`, and the entity calls `remove` once the turn's end is recorded and before it posts what the turn
 * ends with. `discard` is the one attempt at a message whose turn chad closes without running it.
 */

/**
 * The Stop button, which does what `/stop` does. Its id is not `stop`, which is the slash command's: buttons and
 * commands share one id space.
 */
export const StopButton = ChatInteraction.button("stop-turn", {
  label: "Stop",
  style: "danger",
})

/** Where a step of the turn puts its line. The function that adds a line also writes the step's log line. */
export interface Lines {
  readonly add: (line: string) => Effect.Effect<void>
}

/** The lines of what has no status message: a background sub-agent's scripts, and a turn whose post failed. */
export const none: Lines = { add: () => Effect.void }

/**
 * Lines added before the status message is open, so that a step logged before the post still gets its line from the
 * call that logs it. `into` adds them to the message, in their order.
 */
export const pending = () => {
  const added: Array<string> = []
  return {
    add: (line: string) => Effect.sync(() => void added.push(line)),
    into: (status: Lines) =>
      Effect.forEach(added.splice(0), status.add, { discard: true }),
  }
}

export interface StatusMessage extends Lines {
  /** The message's id, or nothing when its post failed. */
  readonly id: string | undefined
  /** Removes the message, once, and drops the edit that waits. A failed removal is logged. */
  readonly remove: Effect.Effect<void>
}

/** Whether a chat call failed because the platform does not have the thread or the message. */
const notFound = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      reason._tag === "Fail" &&
      ChatError.isChatError(reason.error) &&
      reason.error.reason._tag === "NotFound",
  )

/** One attempt to delete a status message, whose failure is logged and nothing more. */
export const discard = (
  chat: ChatService,
  thread: ChatThread.ChatThread,
  id: string,
) =>
  chat
    .delete(thread, id)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logError("The status message could not be removed", cause),
      ),
    )

/**
 * Opens a turn's status message. A turn whose row holds the id of one an earlier start posted edits that one, and
 * posts none. Otherwise it is posted, and `gone` says that the post found the thread gone. Any other failure is
 * logged and the turn goes on without one. Edits wait in `scope`, at most one every `interval`, and every edit sends
 * the Stop button again.
 */
export const open = Effect.fnUntraced(function* (options: {
  readonly chat: ChatService
  readonly thread: ChatThread.ChatThread
  /** The formatter of the connection's platform. */
  readonly format: Format
  /** When the turn started, which the header shows as a relative time. */
  readonly at: number
  readonly stored: string | undefined
  readonly interval: Duration.Duration
  readonly scope: Scope.Scope
}) {
  const { chat, thread } = options
  const lines: Array<string> = []
  const content = () => ({
    markdown: Messages.statusMessage(options.format, options.at, lines),
    actions: [StopButton.of()],
  })
  let id = options.stored
  // When the message was last written. A stored one is edited at its first line.
  let written = 0
  if (id === undefined) {
    const posted = yield* Effect.exit(chat.post(thread, content()))
    if (Exit.isFailure(posted)) {
      if (notFound(posted.cause)) return "gone" as const
      yield* Effect.logError(
        "The status message could not be posted",
        posted.cause,
      )
    } else {
      id = posted.value.id
      written = Date.now()
    }
  }
  const lock = yield* Semaphore.make(1)
  let removed = false
  let scheduled = false
  let waiting: Fiber.Fiber<void> | undefined
  const edit = lock.withPermits(1)(
    Effect.suspend(() => {
      scheduled = false
      waiting = undefined
      if (removed || id === undefined) return Effect.void
      written = Date.now()
      return chat
        .edit(thread, id, content())
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("The status message could not be edited", cause),
          ),
        )
    }),
  )
  const status: StatusMessage = {
    id,
    add: (line) =>
      Effect.suspend(() => {
        if (removed) return Effect.void
        lines.push(line)
        if (lines.length > Messages.statusActions) lines.shift()
        if (id === undefined || scheduled) return Effect.void
        scheduled = true
        const wait = Math.max(
          0,
          written + Duration.toMillis(options.interval) - Date.now(),
        )
        return Effect.forkIn(
          Effect.andThen(Effect.sleep(wait), edit),
          options.scope,
        ).pipe(
          Effect.tap((fiber) =>
            Effect.sync(() => {
              if (scheduled) waiting = fiber
            }),
          ),
          Effect.asVoid,
        )
      }),
    remove: lock.withPermits(1)(
      Effect.suspend(() => {
        if (removed) return Effect.void
        removed = true
        const fiber = waiting
        waiting = undefined
        return Effect.andThen(
          fiber === undefined ? Effect.void : Fiber.interrupt(fiber),
          id === undefined ? Effect.void : discard(chat, thread, id),
        )
      }),
    ),
  }
  return status
})
