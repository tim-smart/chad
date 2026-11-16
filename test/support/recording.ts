import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A recording of the Codex side, which the fake's frames are shaped on (TST-41). `opening` is the request that opened
 * the socket, `answer` the frames of one call that answered with text, and `refusal` the frame of a usage limit. A
 * recording made by `scripts/record-codex.ts` also has every flow it ran, and the flows it could not provoke
 * (TST-216). It has no `refusal` until a run at the usage limit adds one.
 */
export interface Recording {
  readonly source: string
  readonly opening: { readonly headers: Readonly<Record<string, string>> }
  readonly answer: ReadonlyArray<object>
  readonly refusal?: object
  readonly flows?: Readonly<Record<string, Flow>>
  readonly missing?: ReadonlyArray<string>
}

/** One flow of a recorder run: what it was for, how it ended, and each HTTP exchange and socket frame in order. */
export interface Flow {
  readonly note: string
  readonly outcome: string
  readonly events: ReadonlyArray<object>
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
 * alike.
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
])

/**
 * The fields of a form body, which the recorder keeps under `form`, that are kept as they are. Every other field of a
 * form, such as the token exchange's `code`, is stripped.
 */
const formKept = new Set(["grant_type", "client_id", "redirect_uri", "scope"])

/** A JWT, which is what Codex's tokens are, wherever it appears in a string. */
const jwt = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g

/** A recording with every token and the account id stripped, which is what may be kept in the repository (TST-41). */
export const strip = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(jwt, stripped)
  if (Array.isArray(value)) return value.map(strip)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        secret.has(key.toLowerCase()) && field !== null
          ? stripped
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
 * the recorder can refuse to write and say where (TST-216).
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
      secret.has(key.toLowerCase()) && field !== null && field !== stripped
        ? [`${at}.${key}`]
        : leftover(field, known, `${at}.${key}`),
    )
  }
  return []
}

/**
 * The shape of a frame: its keys, and for each the shape of its value, with a primitive as its type and an event's
 * `type` as it is. Two frames of one shape decode alike.
 */
export const shape = (value: unknown, key?: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => shape(item))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, field]) => [name, shape(field, name)]),
    )
  }
  if (key === "type" || key === "object" || key === "status") return value
  return value === null ? "null" : typeof value
}
