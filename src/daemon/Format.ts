import type { ChatThread } from "effect/chat"
import type * as Connections from "../Connections.ts"

/**
 * What a chat platform writes in its own way, so that the status message, the notices and the replies sit on
 * `effect/chat` alone and a platform brings only its formatter.
 */
export interface Format {
  /** A notice inside a turn's flow, as the platform writes it. */
  readonly subtext: (line: string) => string
  /** A link to a thread, as the platform writes one. */
  readonly link: (thread: ChatThread.ChatThread) => string
  /** A moment, shown relative to the reader's now. */
  readonly relativeTime: (at: number) => string
}

/** Discord's markup: `-#` subtext and a `<t:…:R>` timestamp. */
export const discord: Format = {
  subtext: (line) => `-# ${line}`,
  // A Discord thread's id is its channel's.
  link: (thread) => `<#${thread.id}>`,
  relativeTime: (at) => `<t:${Math.floor(at / 1000)}:R>`,
}

/** The local platform stands in for Discord and uses the same markup. */
export const local: Format = discord

/** The formatter of a connection's platform. */
export const of = (kind: Connections.Kind): Format => {
  switch (kind) {
    case "discord":
      return discord
    case "local":
      return local
  }
}
