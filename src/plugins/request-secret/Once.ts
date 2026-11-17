// What the daemon keeps of the one-off values that `requestOnce` asks for. The daemon makes the store
// (src/daemon/Once.ts) and gives it only to the bundled plugins, so a plugin from the repo reads none and its
// `requestOnce` says it cannot take a value. The values live in the daemon's memory and nowhere else.
import { Context, type Duration, type Effect } from "effect"

/** Who asked for a value: the session, its turn, the session's thread as a string, and the value's name. */
export interface Asked {
  readonly session: string
  readonly turn: string
  readonly thread: string
  readonly name: string
}

export interface Store {
  /** How long a request waits for the owner's form. */
  readonly deadline: Duration.Duration
  /**
   * Opens a request and gives its id, which the button carries, and what resolves once the owner's form has stored the
   * value. The request waits until `close`.
   */
  readonly open: (asked: Asked) => {
    readonly id: string
    readonly submitted: Effect.Effect<void>
  }
  /** Ends a request, and says whether its value had arrived. A form submitted after this is discarded. */
  readonly close: (id: string) => boolean
  /** Whether a request waits for its form, which is when a click opens one. */
  readonly waiting: (id: string) => boolean
  /**
   * Stores the value of a waiting request that was submitted in its own thread, under the request's session and name,
   * where it replaces an earlier value of the same name. False when no such request waits, and nothing is stored.
   */
  readonly submit: (id: string, thread: string, value: string) => boolean
  /**
   * The key of a session's running turn, which every process the turn starts gets as `CHAD_TURN_KEY`. It is random,
   * in the daemon's memory only, and made on the first ask of a turn. `forget` retires it, so a process of an earlier
   * turn holds a key that opens nothing.
   */
  readonly key: (session: string) => string
  /**
   * The values of the names that the session whose turn holds `key` has. A name it holds none of is left out, and a
   * key that is not current opens nothing. The session's id is no key: it is on the volume, in the log and in the
   * database.
   */
  readonly read: (
    key: string | undefined,
    names: ReadonlyArray<string>,
  ) => Record<string, string>
  /** Drops what a turn asked for, its values and its requests, and retires its session's key. The turn's end calls this. */
  readonly forget: (session: string | undefined, turn: string) => void
}

/** The daemon's store, or nothing in a plugin the daemon gives none. */
export const Once = Context.Reference<Store | undefined>("chad/daemon/Once", {
  defaultValue: () => undefined,
})
