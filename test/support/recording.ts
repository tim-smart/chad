import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The recording of the Codex side, which the fake's frames are shaped on. `answer` holds the frames of one call that
 * answered with text on each transport, as `scripts/record-codex.ts` recorded them. `refusal` is the frame of a usage
 * limit, which nobody has recorded and which is hand-made.
 */
export interface Recording {
  readonly source: string
  readonly answer: {
    readonly http: ReadonlyArray<object>
    readonly socket: ReadonlyArray<object>
  }
  readonly refusal: object
}

/** Where the kept recording is. */
export const path = join(
  import.meta.dirname,
  "../unit/fixtures/codex-frames.json",
)

export const load = (file: string = path): Recording =>
  JSON.parse(readFileSync(file, "utf8")) as Recording

/** What a stripped value is replaced with. */
export const stripped = "<stripped>"

/**
 * The fields that hold a token, the account id, a code of the login or a cookie, by name, in headers and in bodies
 * alike, and the fields of a response that name the account, the caller or what the proxy set for them.
 */
const secret = new Set([
  "authorization",
  "chatgpt-account-id",
  "access_token",
  "refresh_token",
  "id_token",
  "account_id",
  "chatgpt_account_id",
  "user_id",
  "user",
  "email",
  "safety_identifier",
  "device_auth_id",
  "user_code",
  "authorization_code",
  "code_verifier",
  "cookie",
  "set-cookie",
  "prompt_cache_key",
  "metadata",
  "access_programs",
])

/**
 * The fields that are secret only as text. A response's `instructions` are the caller's, and the `instructions` of
 * `usage.attribution.request_fields` are token counts, which are kept.
 */
const secretText = new Set(["instructions"])

const isSecret = (key: string, field: unknown) =>
  secret.has(key.toLowerCase()) ||
  (secretText.has(key.toLowerCase()) && typeof field === "string")

/**
 * The fields of a form body, which the recorder keeps under `form`, that are kept as they are. Every other field of a
 * form, such as the token exchange's `code`, is stripped.
 */
const formKept = new Set(["grant_type", "client_id", "redirect_uri", "scope"])

/**
 * The parts of an endpoint's host and path that a kept recording must not hold. A part as short as a common word, such
 * as `api` or `com`, is left out, because the frames hold such words anyway.
 */
export const hostParts = (url: string): ReadonlyArray<string> => {
  const { hostname, pathname } = new URL(url)
  return [hostname, ...hostname.split(/[.-]/), ...pathname.split(/[/._-]/)]
    .filter((part) => part.length > 4)
    .filter((part, index, all) => all.indexOf(part) === index)
}

/** An id the service gives a response or an item, such as `resp_…` or `msg_…`. */
const serviceId = /^([a-z]+)_(?=[A-Za-z]*[0-9])([A-Za-z0-9]{12,})$/

/**
 * The recording with each id the service gave renumbered in order of appearance, `msg_0` for the first message and so
 * on, as the fake numbers its own. An id names one call in the service's logs, and it is not kept.
 */
export const renumber = (value: unknown): unknown => {
  const seen = new Map<string, string>()
  const counts = new Map<string, number>()
  const id = (text: string) => {
    const match = serviceId.exec(text)
    if (match === null) return text
    const known = seen.get(text)
    if (known !== undefined) return known
    const prefix = match[1]!
    const n = counts.get(prefix) ?? 0
    counts.set(prefix, n + 1)
    const next = `${prefix}_${n}`
    seen.set(text, next)
    return next
  }
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return id(item)
    if (Array.isArray(item)) return item.map(walk)
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(
        Object.entries(item).map(([key, field]) => [id(key), walk(field)]),
      )
    }
    return item
  }
  return walk(value)
}

/** The frames of one recorded call as they may be kept: stripped and renumbered. */
export const keep = (frames: ReadonlyArray<object>): ReadonlyArray<object> =>
  renumber(strip(frames)) as ReadonlyArray<object>

/** A JWT, which is what Codex's tokens are, wherever it appears in a string. */
const jwt = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g

/**
 * A secret field's value with nothing of it left but its type, so that a stripped frame keeps its shape: a string is
 * `<stripped>`, an object `{}`, a list `[]` and a number 0.
 */
const blank = (field: unknown): unknown =>
  typeof field === "string"
    ? stripped
    : Array.isArray(field)
      ? []
      : typeof field === "object" && field !== null
        ? {}
        : typeof field === "number"
          ? 0
          : field

const isBlank = (field: unknown) =>
  JSON.stringify(blank(field)) === JSON.stringify(field)

/** A recording with every token and the account id stripped, which is what may be kept in the repository. */
export const strip = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(jwt, stripped)
  if (Array.isArray(value)) return value.map(strip)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        isSecret(key, field)
          ? blank(field)
          : key === "form" && typeof field === "object" && field !== null
            ? Object.fromEntries(
                Object.entries(field).map(([name, text]) => [
                  name,
                  formKept.has(name) ? text : stripped,
                ]),
              )
            : strip(field),
      ]),
    )
  }
  return value
}

/**
 * Where a stripped recording still holds a secret: a JWT, a secret field that was not stripped, or one of the values
 * the recorder saw as a token, an id or a code of the login. It gives each place as a path, never the value, so that
 * the recorder can refuse to write and say where.
 */
export const leftover = (
  value: unknown,
  known: ReadonlyArray<string>,
  at = "$",
): ReadonlyArray<string> => {
  if (typeof value === "string") {
    jwt.lastIndex = 0
    return jwt.test(value) || known.some((secret) => value.includes(secret))
      ? [at]
      : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      leftover(item, known, `${at}[${index}]`),
    )
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, field]) =>
      isSecret(key, field) && !isBlank(field)
        ? [`${at}.${key}`]
        : leftover(field, known, `${at}.${key}`),
    )
  }
  return []
}

/** An id as an object's key: a prefix, and letters and digits with a digit among them, as `msg_0` is. */
const itemId = /^[a-z]+_(?=[A-Za-z]*[0-9])[A-Za-z0-9]+$/

/**
 * The shape of a frame: its keys, and for each the shape of its value, with a primitive as its type and an event's
 * `type` as it is. Two frames of one shape decode alike.
 */
export const shape = (value: unknown, key?: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => shape(item))
  if (typeof value === "object" && value !== null) {
    // An object keyed by item id, as `usage.attribution.items` is, has the shapes of its entries and not their ids.
    const entries = Object.entries(value)
    if (entries.length > 0 && entries.every(([name]) => itemId.test(name))) {
      return {
        "<item id>": entries
          .map(([, field]) => shape(field))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, field]) => [name, shape(field, name)]),
    )
  }
  if (key === "type" || key === "object" || key === "status") return value
  return value === null ? "null" : typeof value
}

/**
 * The shapes of a call's frames in order, with a run of frames of one shape counted once, so that an answer in two
 * deltas and an answer in one have the same shapes.
 */
export const shapes = (frames: ReadonlyArray<object>): ReadonlyArray<unknown> =>
  frames
    .map((frame) => shape(frame))
    .filter(
      (item, index, all) =>
        index === 0 || JSON.stringify(item) !== JSON.stringify(all[index - 1]),
    )
