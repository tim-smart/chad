import { DiscordChat } from "@effect/chat-discord"
import type { Effect } from "effect"
import type * as Connections from "../Connections.ts"

/**
 * What a chat platform writes in its own way, so that the status message, the notices and the replies sit on
 * `effect/chat` alone and a platform brings only its formatter.
 */
export interface Format {
  /** A notice inside a turn's flow, as the platform writes it (docs/spec/04-discord.md, DIS-22, DIS-74). */
  readonly subtext: (line: string) => string
  /** A moment, shown relative to the reader's now (DIS-20). */
  readonly relativeTime: (at: number) => string
  /**
   * The platform's post options for a reply to the owner's message: the reply ping on and no other mention, and a
   * message that is gone does not refuse the post (DIS-55, DIS-52, DIS-100).
   */
  readonly reply: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

/** Discord's markup: `-#` subtext and a `<t:…:R>` timestamp. */
export const discord: Format = {
  subtext: (line) => `-# ${line}`,
  relativeTime: (at) => `<t:${Math.floor(at / 1000)}:R>`,
  // Discord posts a reply to a message that is gone as a plain message, and does not refuse it (DIS-100).
  reply: DiscordChat.withPostOptions({
    notify: { repliedUser: true },
    failIfNotExists: false,
  }),
}

/**
 * The local platform stands in for Discord (DIS-79, OV-5), so the owner reads the same markup. It has no Discord post
 * options, so a reply is posted as it is.
 */
export const local: Format = {
  subtext: discord.subtext,
  relativeTime: discord.relativeTime,
  reply: (effect) => effect,
}

/** The formatter of a connection's platform. */
export const of = (kind: Connections.Kind): Format => {
  switch (kind) {
    case "discord":
      return discord
    case "local":
      return local
  }
}
