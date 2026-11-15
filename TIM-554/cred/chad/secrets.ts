// PROTOTYPE for "Credential tools run on real clanka and a browser sidecar" (TIM-554). Throwaway.
// The secret store, TOTP and masking. No effect imports: the CLI loads this file alone for
// `run` and `code`, which never talk to the daemon.
import { createHmac } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const DATA = process.env.CHAD_DATA ?? "data"
export const SECRETS = join(DATA, "secrets", "secrets.json")

export interface Totp {
  readonly digits: number
  readonly period: number
  readonly algorithm: "sha1" | "sha256" | "sha512"
}
export interface Entry {
  /** A plain value, or the base32 seed in canonical spelling (upper case, no spaces, no padding). */
  readonly value: string
  readonly kind: "plain" | "totp"
  readonly note?: string | undefined
  readonly date: string
  readonly totp?: Totp | undefined
  /** What the owner typed, when it differs from `value`. Masked too. */
  readonly typed?: string | undefined
}
export type Store = Record<string, Entry>

export const load = (file = SECRETS): Store => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}
export const save = (store: Store, file = SECRETS) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + "." + process.pid + ".tmp"
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}
export const NAME = /^[A-Z][A-Z0-9_]*$/

// --- TOTP, RFC 6238 on node:crypto ---------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
export const base32Decode = (text: string): Buffer | undefined => {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase()
  if (clean.length === 0) return undefined
  let bits = 0
  let acc = 0
  const out: Array<number> = []
  for (const ch of clean) {
    const v = B32.indexOf(ch)
    if (v === -1) return undefined
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return out.length === 0 ? undefined : Buffer.from(out)
}
export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0
  let acc = 0
  let out = ""
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += B32[(acc >> bits) & 31]
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]
  return out
}

/** base32, or an otpauth:// URI. Gives the reason when it does not decode. */
export const parseTotp = (input: string): { seed: string; totp: Totp } | { error: string } => {
  const text = input.trim()
  let seed = text
  let digits = 6
  let period = 30
  let algorithm: Totp["algorithm"] = "sha1"
  if (/^otpauth:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return { error: "not a valid otpauth:// URI" }
    }
    if (url.host !== "totp") return { error: "only otpauth://totp is supported, got otpauth://" + url.host }
    seed = url.searchParams.get("secret") ?? ""
    if (url.searchParams.has("digits")) digits = Number(url.searchParams.get("digits"))
    if (url.searchParams.has("period")) period = Number(url.searchParams.get("period"))
    const a = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase()
    if (a !== "sha1" && a !== "sha256" && a !== "sha512") return { error: "unknown algorithm " + a }
    algorithm = a
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) return { error: "digits must be 6, 7 or 8" }
  if (!Number.isInteger(period) || period < 1) return { error: "period must be a whole number of seconds" }
  const bytes = base32Decode(seed)
  if (bytes === undefined) return { error: "the seed is not base32" }
  return { seed: base32Encode(bytes), totp: { digits, period, algorithm } }
}

export const hotp = (key: Buffer, counter: number, t: Totp): string => {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(t.algorithm, key).update(msg).digest()
  const off = mac[mac.length - 1] & 0xf
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]
  return String(bin % 10 ** t.digits).padStart(t.digits, "0")
}
/** Test-only: CHAD_PROTO_TIME_OFFSET_MS moves this process's clock. */
export const now = () => Date.now() + Number(process.env.CHAD_PROTO_TIME_OFFSET_MS ?? 0)
export const codeAt = (entry: Entry, ms: number): { code: string; left: number } => {
  const t = entry.totp ?? { digits: 6, period: 30, algorithm: "sha1" as const }
  const seconds = Math.floor(ms / 1000)
  const counter = Math.floor(seconds / t.period)
  return { code: hotp(base32Decode(entry.value)!, counter, t), left: t.period - (seconds % t.period) }
}
/** Under 5 seconds left: wait for the next window, so the code is not stale by the time it is typed. */
export const currentCode = async (entry: Entry): Promise<{ code: string; left: number; waited: number }> => {
  const first = codeAt(entry, now())
  if (first.left >= 5) return { ...first, waited: 0 }
  const t = entry.totp?.period ?? 30
  const wait = (t - ((now() / 1000) % t)) * 1000 + 20
  await new Promise((r) => setTimeout(r, wait))
  return { ...codeAt(entry, now()), waited: Math.round(wait) }
}

// --- masking -------------------------------------------------------------------------------

export const MASK_MIN = 8
interface Needle {
  readonly text: string
  readonly name: string
}
/** Longest first, so a value that contains another is replaced whole. */
export const needles = (store: Store): Array<Needle> => {
  const out: Array<Needle> = []
  const add = (text: string | undefined, name: string) => {
    if (text === undefined || text.length < MASK_MIN) return
    out.push({ text, name })
    if (process.env.PROTO_MASK_ESCAPED !== "0") {
      // The spelling the value has inside a JSON or JavaScript string literal.
      const escaped = JSON.stringify(text).slice(1, -1)
      if (escaped !== text) out.push({ text: escaped, name })
    }
  }
  for (const [name, entry] of Object.entries(store)) {
    add(entry.value, name)
    add(entry.typed, name)
  }
  return out.sort((a, b) => b.text.length - a.text.length)
}
export const maskWith = (list: ReadonlyArray<Needle>) => (text: string): string => {
  let out = text
  for (const n of list) if (out.includes(n.text)) out = out.split(n.text).join("<secret:" + n.name + ">")
  return out
}
/** Every string inside a JSON-shaped value. Masking the serialised text instead misses a value with a quote or a backslash in it. */
export const deep = (f: (s: string) => string) => {
  const go = (v: unknown): unknown => {
    if (typeof v === "string") return f(v)
    if (Array.isArray(v)) return v.map(go)
    if (v !== null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) o[f(k)] = go(x)
      return o
    }
    return v
  }
  return go
}
/** Names whose value appears in the text. For evidence: says which, never prints one. */
export const found = (store: Store, text: string): Array<string> =>
  Object.entries(store).filter(([, e]) => e.value.length >= 1 && (text.includes(e.value) || (e.typed !== undefined && text.includes(e.typed)))).map(([n]) => n)
