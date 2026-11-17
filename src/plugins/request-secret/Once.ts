// What the daemon keeps of the requests that `requestOnce` makes: each one waits for the owner's form, and the submit
// hands the value to the tool that waits. The daemon makes the store (src/daemon/Once.ts) and gives it only to the
// bundled plugins, so a plugin from the repo reads none and its `requestOnce` says it cannot take a value. No request
// outlives the tool call that opened it, and none is written anywhere.
import { Context, type Duration, type Effect } from "effect"

export interface Store {
  /** How long a request waits for the owner's form. */
  readonly deadline: Duration.Duration
  /**
   * Opens a request in a thread, given as a string, and gives its id, which the button carries, and what resolves
   * with the value once the owner's form arrives. The request waits until `close`.
   */
  readonly open: (thread: string) => {
    readonly id: string
    readonly submitted: Effect.Effect<string>
  }
  /** Ends a request, and gives its value when one had arrived. A form submitted after this is discarded. */
  readonly close: (id: string) => string | undefined
  /** Whether a request waits for its form, which is when a click opens one. */
  readonly waiting: (id: string) => boolean
  /**
   * Hands the value of a waiting request, submitted in its own thread, to the tool that waits. False when no such
   * request waits, and the value goes nowhere.
   */
  readonly submit: (id: string, thread: string, value: string) => boolean
}

/** The daemon's store, or nothing in a plugin the daemon gives none. */
export const Once = Context.Reference<Store | undefined>("chad/daemon/Once", {
  defaultValue: () => undefined,
})
