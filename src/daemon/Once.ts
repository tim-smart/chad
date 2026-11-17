// The one-off values that `requestOnce` asks the owner for, such as a code a site sent by SMS. They live in the
// daemon's memory and nowhere else: not in the secret store, the session's history, the log or a backup. Each belongs to
// the session that asked and to the turn it asked in. The turn's end drops it, and so does the end of the process.
import { randomBytes, randomUUID } from "node:crypto"
import { Deferred, type Duration, Exit } from "effect"
import type { Asked, Store } from "../plugins/request-secret/Once.ts"

export type { Store } from "../plugins/request-secret/Once.ts"

/** One request that waits for the owner's form. */
interface Pending {
  readonly asked: Asked
  readonly submitted: Deferred.Deferred<void>
}

export const make = (deadline: Duration.Duration): Store => {
  const pending = new Map<string, Pending>()
  /** By session, then by name. */
  const values = new Map<
    string,
    Map<string, { readonly turn: string; readonly value: string }>
  >()
  /** The key of each session's running turn, and the session of each key. */
  const keys = new Map<string, string>()
  const sessions = new Map<string, string>()
  return {
    deadline,
    open: (asked) => {
      const id = randomUUID()
      const submitted = Deferred.makeUnsafe<void>()
      pending.set(id, { asked, submitted })
      return { id, submitted: Deferred.await(submitted) }
    },
    close: (id) => {
      const request = pending.get(id)
      pending.delete(id)
      return request !== undefined && Deferred.isDoneUnsafe(request.submitted)
    },
    waiting: (id) => {
      const request = pending.get(id)
      return request !== undefined && !Deferred.isDoneUnsafe(request.submitted)
    },
    submit: (id, thread, value) => {
      const request = pending.get(id)
      if (
        request === undefined ||
        request.asked.thread !== thread ||
        Deferred.isDoneUnsafe(request.submitted)
      )
        return false
      const { session, turn, name } = request.asked
      let held = values.get(session)
      if (held === undefined) {
        held = new Map()
        values.set(session, held)
      }
      held.set(name, { turn, value })
      Deferred.doneUnsafe(request.submitted, Exit.void)
      return true
    },
    key: (session) => {
      const held = keys.get(session)
      if (held !== undefined) return held
      const key = randomBytes(32).toString("base64url")
      keys.set(session, key)
      sessions.set(key, session)
      return key
    },
    read: (key, names) => {
      const session = key === undefined ? undefined : sessions.get(key)
      const held = session === undefined ? undefined : values.get(session)
      const found: Record<string, string> = {}
      if (held === undefined) return found
      for (const name of names) {
        const entry = held.get(name)
        if (entry !== undefined) found[name] = entry.value
      }
      return found
    },
    forget: (session, turn) => {
      const key = session === undefined ? undefined : keys.get(session)
      if (session !== undefined && key !== undefined) {
        keys.delete(session)
        sessions.delete(key)
      }
      for (const [id, request] of pending) {
        if (request.asked.turn === turn) pending.delete(id)
      }
      for (const [session, held] of values) {
        for (const [name, entry] of held) {
          if (entry.turn === turn) held.delete(name)
        }
        if (held.size === 0) values.delete(session)
      }
    },
  }
}
