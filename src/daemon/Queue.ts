import { Effect, Semaphore } from "effect"
import * as Logger from "./Logger.ts"

/**
 * The daemon's one queue for everything that changes what is loaded. What runs through it runs alone, and the next
 * one starts when it ends.
 */
export interface Queue {
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export const make = (): Queue => {
  const semaphore = Semaphore.makeUnsafe(1)
  return { run: semaphore.withPermit }
}

/** The caller of a command, from the `CHAD_SESSION` its CLI sent: the owner when it sent none. */
export const caller = (session: string | undefined): string =>
  session ?? "owner"

/** The line a command that changes something leaves when it finishes. It never carries a secret's value. */
export const ran = (
  command: string,
  caller: string,
  outcome: "changed" | "unchanged" | "refused",
  fields: Readonly<Record<string, string>> = {},
) =>
  Logger.event("command.ran", "A command finished", {
    command,
    caller,
    outcome,
    ...fields,
  })
