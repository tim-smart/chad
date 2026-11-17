// The requests that `requestOnce` makes, in the daemon's memory. A submit hands its value straight to the tool that
// waits, and the store keeps no value: once the tool has it, it is the tool's result. Nothing here writes to the volume,
// and a restart drops every request.
import { randomUUID } from "node:crypto"
import { Deferred, type Duration, Exit } from "effect"
import type { Store } from "../plugins/request-secret/Once.ts"

export type { Store } from "../plugins/request-secret/Once.ts"

/** One request that waits for the owner's form. */
interface Pending {
  readonly thread: string
  readonly submitted: Deferred.Deferred<string>
  /** The value, once a form has given it. */
  value: string | undefined
}

export const make = (deadline: Duration.Duration): Store => {
  const pending = new Map<string, Pending>()
  return {
    deadline,
    open: (thread) => {
      const id = randomUUID()
      const submitted = Deferred.makeUnsafe<string>()
      pending.set(id, { thread, submitted, value: undefined })
      return { id, submitted: Deferred.await(submitted) }
    },
    close: (id) => {
      const request = pending.get(id)
      pending.delete(id)
      return request?.value
    },
    waiting: (id) => {
      const request = pending.get(id)
      return request !== undefined && !Deferred.isDoneUnsafe(request.submitted)
    },
    submit: (id, thread, value) => {
      const request = pending.get(id)
      if (
        request === undefined ||
        request.thread !== thread ||
        Deferred.isDoneUnsafe(request.submitted)
      )
        return false
      request.value = value
      Deferred.doneUnsafe(request.submitted, Exit.succeed(value))
      return true
    },
  }
}
