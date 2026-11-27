// The requests that `requestOnce` makes, in the daemon's memory. A submit hands its value straight to the tool that
// waits, which returns it to the calling script and nowhere else. The daemon also remembers each value for the session
// that asked, so that the session's log lines, its script output and its commands' output carry a mask in its place
// (`SessionEntity.ts`, `Spawner.ts`). It forgets them when the turn that asked ends. A stream of output that was open
// then, such as a background command's, keeps masking the values it saw. Nothing here writes to the volume, and a
// restart forgets everything.
//
// The mask is a match of the exact value, nothing more: a script that encodes the value, splits it with other text,
// writes it to a file or sends it somewhere gets past it. A value that is an address, such as the one a browser ended
// on after an OAuth approval, also masks each of its query and fragment parameters' values, as they are written in the
// address and decoded, so the `code` a script pulls out of it stays masked. Each of these is also masked as a command
// line spells it in single quotes.
//
// A stored secret that `fillSecret` put into a page is masked the same way, as `[secret NAME]`, for as long as the
// session lives in this daemon and not only for the turn, since the page keeps the value after the turn ends.
import { randomUUID } from "node:crypto"
import { Deferred, type Duration, Exit } from "effect"
import type { Store } from "../plugins/request-secret/Once.ts"

/** What a value is replaced with in a session's log lines and script output. */
export const mask = "[one-off value]"

/** What a stored secret's value is replaced with once `fillSecret` handed it to a page. */
export const secretMask = (name: string) => `[secret ${name}]`

/** The store, with what the daemon redacts a session's output by. */
export interface Daemon extends Omit<Store, "fill"> {
  /**
   * Masks a stored secret's value in the session's output from now on, its single-quoted and JSON-escaped spellings
   * included, for as long as the daemon runs. A `forget` keeps it.
   */
  readonly hide: (session: string, name: string, value: string) => void
  /**
   * Every secret any session filled, as it is and single-quoted, which the MCP layer's own log lines mask, since a
   * server's stderr is logged on no session's fiber. The MCP scrubber adds the JSON and URL spellings itself.
   */
  readonly filled: () => Iterable<string>
  /** A text with each value the session was given replaced by the mask. */
  readonly scrub: (session: string, text: string) => string
  /**
   * A redactor of one stream of a session's output. `push` gives the chunk's text that is safe to pass on and holds
   * back, unmasked, an end that could still become a longer value, so a value split across chunks is masked whole.
   * `end` gives what was held back, masked. It masks every value the session held while it ran, those it held when it
   * was made included, so a `forget` does not unmask a stream that outlives the turn.
   */
  readonly redactor: (session: string) => {
    readonly push: (chunk: string) => string
    readonly end: () => string
    /** A whole text, such as an error's, with every value this redactor masks replaced. */
    readonly scrub: (text: string) => string
  }
  /** Whether the session was given a value or filled a secret, so its output has something to mask. */
  readonly holds: (session: string) => boolean
  /** Forgets the one-off values a session was given. The end of each of its turns calls this. */
  readonly forget: (session: string) => void
}

/** The shortest parameter value of an address that is masked on its own, so a value such as `0` masks nothing else. */
const partLength = 8

/** The query and the fragment of an address as the owner wrote it, before a URL parser re-encodes either. */
const written = (value: string): ReadonlyArray<string> => {
  const hash = value.indexOf("#")
  const before = hash === -1 ? value : value.slice(0, hash)
  const query = before.indexOf("?")
  return [
    query === -1 ? "" : before.slice(query + 1),
    hash === -1 ? "" : value.slice(hash + 1),
  ]
}

/**
 * The values of the query and fragment parameters of a value that parses as an address: as the owner wrote them, as
 * the URL parser writes them, which percent-encodes characters such as `'`, as a form decodes them, which is what
 * `URLSearchParams` gives, and as `decodeURIComponent` decodes them where it can.
 */
const parts = (value: string): ReadonlyArray<string> => {
  if (!URL.canParse(value)) return []
  const url = new URL(value)
  const found = new Set<string>()
  for (const params of [
    ...written(value),
    url.search.slice(1),
    url.hash.slice(1),
  ]) {
    for (const pair of params.split("&")) {
      const equals = pair.indexOf("=")
      if (equals === -1) continue
      const raw = pair.slice(equals + 1)
      found.add(raw)
      try {
        found.add(decodeURIComponent(raw))
      } catch {
        // A malformed escape: the form-decoded value below still decodes the valid ones.
      }
    }
    for (const decoded of new URLSearchParams(params).values())
      found.add(decoded)
  }
  return [...found].filter((part) => part.length >= partLength)
}

/**
 * A value as a shell command line spells it in single quotes, each `'` written `'\''`, which is how the `credentials`
 * skill hands a value to a command. The traced command line then holds this spelling and not the value.
 */
const quoted = (value: string) => value.replaceAll("'", "'\\''")

/** One request that waits for the owner's form. */
interface Pending {
  readonly thread: string
  readonly session: string
  readonly submitted: Deferred.Deferred<string>
  /** The value, once a form has given it. */
  value: string | undefined
}

/** The values to mask, each with its mask, the longest value first. */
type Masks = ReadonlyArray<readonly [value: string, mask: string]>

const sorted = (masks: Iterable<readonly [string, string]>): Masks =>
  [...new Map(masks)].sort(([a], [b]) => b.length - a.length)

/**
 * A text with each value replaced by its mask. It reads from the start and masks the longest value that begins at each
 * place, so one value inside another, such as an address's code, is masked with the whole. Unless `final`, it stops at
 * the first place where a value longer than any that matches there could still be completed by text yet to come, and
 * gives the text from there as `rest`, unmasked, to be read again with what follows.
 */
const scan = (
  text: string,
  values: Masks,
  final: boolean,
): { readonly out: string; readonly rest: string } => {
  let out = ""
  let from = 0
  let at = 0
  while (at < text.length) {
    const left = text.length - at
    let matched: readonly [string, string] | undefined
    let open = false
    // The values are the longest first, so the first that matches or may still match decides.
    for (const entry of values) {
      const value = entry[0]
      if (value.length <= left) {
        if (text.startsWith(value, at)) {
          matched = entry
          break
        }
      } else if (
        !final &&
        value.charCodeAt(0) === text.charCodeAt(at) &&
        value.startsWith(text.slice(at))
      ) {
        open = true
        break
      }
    }
    if (open) return { out: out + text.slice(from, at), rest: text.slice(at) }
    if (matched === undefined) {
      at++
      continue
    }
    out += text.slice(from, at) + matched[1]
    at += matched[0].length
    from = at
  }
  return { out: out + text.slice(from), rest: "" }
}

/** Masks whole values in a diagnostic, matching the longest value first as a session's redactor does. */
export const scrubValues = (
  text: string,
  values: ReadonlyArray<string>,
): string => {
  const masks = sorted(
    values.filter(Boolean).map((value) => [value, mask] as const),
  )
  return masks.length === 0 ? text : scan(text, masks, true).out
}

export const make = (deadline: Duration.Duration): Daemon => {
  const pending = new Map<string, Pending>()
  /** The one-off values each session was given, by value, which the end of a turn forgets. */
  const given = new Map<string, Map<string, string>>()
  /** The stored secrets each session filled into a page, by value, which nothing forgets. */
  const hidden = new Map<string, Map<string, string>>()
  const add = (
    into: Map<string, Map<string, string>>,
    session: string,
    values: Iterable<string>,
    masked: string,
  ) => {
    const masks = into.get(session) ?? new Map<string, string>()
    for (const value of values) if (value !== "") masks.set(value, masked)
    into.set(session, masks)
    cache.delete(session)
  }
  /** Every secret any session filled, for the MCP layer's log lines. */
  const filled = new Set<string>()
  /** Each session's masks, sorted once per change, since every log line and output chunk of the session reads them. */
  const cache = new Map<string, Masks>()
  /** The masks of a session that holds none, which is not cached, so such a session's id is not kept. */
  const none: Masks = []
  const valuesOf = (session: string): Masks => {
    let masks = cache.get(session)
    if (masks === undefined) {
      const fills = hidden.get(session)
      const once = given.get(session)
      if (fills === undefined && once === undefined) return none
      masks = sorted([...(fills ?? []), ...(once ?? [])])
      cache.set(session, masks)
    }
    return masks
  }
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
      add(
        given,
        request.session,
        [value, ...parts(value)].flatMap((part) => [part, quoted(part)]),
        mask,
      )
      request.value = value
      Deferred.doneUnsafe(request.submitted, Exit.succeed(value))
      return true
    },
    hide: (session, name, value) => {
      add(
        hidden,
        session,
        [value, quoted(value), JSON.stringify(value).slice(1, -1)],
        secretMask(name),
      )
      filled.add(value).add(quoted(value))
    },
    filled: () => filled,
    holds: (session) =>
      (given.get(session)?.size ?? 0) + (hidden.get(session)?.size ?? 0) > 0,
    forget: (session) => {
      if (given.delete(session)) cache.delete(session)
    },
    scrub: (session, text) => {
      const values = valuesOf(session)
      return values.length === 0 ? text : scan(text, values, true).out
    },
    redactor: (session) => {
      let rest = ""
      /** Every value the session held while this stream ran, the longest first. */
      let values: Masks = valuesOf(session)
      /** The session's masks as last read, so an unchanged list costs one comparison. */
      let last = values
      const seen = () => {
        const now = valuesOf(session)
        if (now === last) return values
        last = now
        values = sorted([...now, ...values])
        return values
      }
      return {
        push: (chunk) => {
          const values = seen()
          if (values.length === 0 && rest === "") return chunk
          const scanned = scan(rest + chunk, values, false)
          rest = scanned.rest
          return scanned.out
        },
        end: () => {
          const text = rest
          rest = ""
          return text === "" ? text : scan(text, seen(), true).out
        },
        scrub: (text) => {
          const values = seen()
          return values.length === 0 ? text : scan(text, values, true).out
        },
      }
    },
  }
}
