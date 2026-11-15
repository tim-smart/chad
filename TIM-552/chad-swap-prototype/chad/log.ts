// PROTOTYPE for "The plugin swap run with live sessions" (TIM-552). Throwaway.
import { appendFileSync } from "node:fs"

export const LOG = process.env.PROTO_LOG ?? "events.jsonl"
/** Every observable step goes to one JSON-lines file, written synchronously so a kill cannot lose it. */
export const log = (ev: string, data: Record<string, unknown> = {}) =>
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ev, ...data }) + "\n")
