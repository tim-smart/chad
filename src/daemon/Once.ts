// The requests that `requestOnce` makes, in the daemon's memory. A submit hands its value straight to the tool that
// waits, which returns it to the calling script and nowhere else. The daemon also remembers each value for the session
// that asked, so that the session's log lines, its script output and its commands' output carry a mask in its place
// (`SessionEntity.ts`, `Spawner.ts`). It forgets them when the session's executor closes, which takes clanka's copies of
// the session's commands with it. Nothing here writes to the volume, and a restart forgets everything.
//
// The mask is a match of the exact value, nothing more: a script that encodes the value, splits it with other text,
// writes it to a file or sends it somewhere gets past it.
import { randomUUID } from "node:crypto"
import { Deferred, type Duration, Exit } from "effect"
import type { Store } from "../plugins/request-secret/Once.ts"

/** What a value is replaced with in a session's log lines and script output. */
export const mask = "[one-off value]"

/** The store, with what the daemon redacts a session's output by. */
export interface Daemon extends Store {
  /** A text with each value the session was given replaced by the mask. */
  readonly scrub: (session: string, text: string) => string
  /**
   * A redactor of one stream of a session's output. `push` gives the chunk's text that is safe to pass on and holds
   * back an end that could be the start of a value, so a value split across chunks is still masked. `end` gives what
   * was held back.
   */
  readonly redactor: (session: string) => {
    readonly push: (chunk: string) => string
    readonly end: () => string
  }
  /** Whether the session was given a value, so its output has something to mask. */
  readonly holds: (session: string) => boolean
  /**
   * Forgets the values a session was given. The session's executor calls this as it closes, which is when the copies
   * clanka kept of its commands and their output go too.
   */
  readonly forget: (session: string) => void
}

/** One request that waits for the owner's form. */
interface Pending {
  readonly thread: string
  readonly session: string
  readonly submitted: Deferred.Deferred<string>
  /** The value, once a form has given it. */
  value: string | undefined
}

/** Each value in a text replaced by the mask, the longest first so that one value inside another is masked whole. */
const replace = (text: string, values: ReadonlyArray<string>) => {
  let out = text
  for (const value of values) out = out.split(value).join(mask)
  return out
}

/** The length of the longest end of a text that is the start of a value, and shorter than the value. */
const held = (text: string, values: ReadonlyArray<string>) => {
  let longest = 0
  for (const value of values) {
    for (
      let length = Math.min(value.length - 1, text.length);
      length > longest;
      length--
    ) {
      if (text.endsWith(value.slice(0, length))) {
        longest = length
        break
      }
    }
  }
  return longest
}

export const make = (deadline: Duration.Duration): Daemon => {
  const pending = new Map<string, Pending>()
  /** The values each session was given, the longest first. */
  const given = new Map<string, Array<string>>()
  const valuesOf = (session: string): ReadonlyArray<string> =>
    given.get(session) ?? []
  return {
    deadline,
    open: (thread, session) => {
      const id = randomUUID()
      const submitted = Deferred.makeUnsafe<string>()
      pending.set(id, { thread, session, submitted, value: undefined })
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
      // The value is masked from here on, before the script that asked can print it.
      if (value !== "") {
        const values = given.get(request.session) ?? []
        if (!values.includes(value)) values.push(value)
        values.sort((a, b) => b.length - a.length)
        given.set(request.session, values)
      }
      request.value = value
      Deferred.doneUnsafe(request.submitted, Exit.succeed(value))
      return true
    },
    holds: (session) => (given.get(session)?.length ?? 0) > 0,
    forget: (session) => {
      given.delete(session)
    },
    scrub: (session, text) => {
      const values = valuesOf(session)
      return values.length === 0 ? text : replace(text, values)
    },
    redactor: (session) => {
      let rest = ""
      return {
        push: (chunk) => {
          const values = valuesOf(session)
          if (values.length === 0 && rest === "") return chunk
          const text = replace(rest + chunk, values)
          const keep = held(text, values)
          rest = text.slice(text.length - keep)
          return text.slice(0, text.length - keep)
        },
        end: () => {
          const text = rest
          rest = ""
          return text
        },
      }
    },
  }
}
