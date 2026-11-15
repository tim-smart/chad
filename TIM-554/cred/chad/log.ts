// PROTOTYPE (TIM-554). The event log, and the one masking function every output of chad goes through.
import { appendFileSync, statSync } from "node:fs"
import * as S from "./secrets.ts"

export const LOG = process.env.PROTO_LOG ?? "events.jsonl"

let cache = { stamp: "", store: {} as S.Store, mask: (s: string) => s }
/** The store as it is on disk now, reread when the file changed. */
export const secrets = () => {
  let stamp = "none"
  try {
    const st = statSync(S.SECRETS)
    stamp = st.mtimeMs + "/" + st.size + "/" + st.ino
  } catch {}
  if (stamp !== cache.stamp) {
    const store = S.load()
    cache = { stamp, store, mask: S.maskWith(S.needles(store)) }
  }
  return cache
}
export const mask = (text: string): string => (process.env.PROTO_NO_MASK === "1" ? text : secrets().mask(text))
export const maskDeep = <A>(value: A): A => S.deep(mask)(value) as A

/** Every observable step goes to one JSON-lines file, written synchronously so a kill cannot lose it. Masked like any other output. */
export const log = (ev: string, data: Record<string, unknown> = {}) =>
  appendFileSync(LOG, JSON.stringify(maskDeep({ t: Date.now(), pid: process.pid, ev, ...data })) + "\n")
