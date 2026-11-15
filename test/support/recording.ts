import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A recording of the Codex side, which the fake's frames are shaped on (TST-41). `opening` is the request that opened
 * the socket, `answer` the frames of one call that answered with text, and `refusal` the frame of a usage limit.
 */
export interface Recording {
  readonly source: string
  readonly opening: { readonly headers: Readonly<Record<string, string>> }
  readonly answer: ReadonlyArray<object>
  readonly refusal: object
}

/** Where the kept recording is. */
export const path = join(
  import.meta.dirname,
  "../unit/fixtures/codex-frames.json",
)

export const load = (): Recording =>
  JSON.parse(readFileSync(path, "utf8")) as Recording

/** What a stripped value is replaced with. */
export const stripped = "<stripped>"

/** The fields that hold a token or the account id, by name, in headers and in bodies alike. */
const secret = new Set([
  "authorization",
  "chatgpt-account-id",
  "access_token",
  "refresh_token",
  "id_token",
  "account_id",
  "chatgpt_account_id",
  "user_id",
  "email",
])

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
          : strip(field),
      ]),
    )
  }
  return value
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
