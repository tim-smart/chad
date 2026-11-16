import { Effect, Semaphore } from "effect"
import * as Logger from "./Logger.ts"

/**
 * The daemon's one queue for everything that changes what is loaded. What runs through it runs alone, and the next
 * one starts when it ends.
 */
export interface Queue {
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    label?: string,
  ) => Effect.Effect<A, E, R>
  /** What runs now, by the label it was queued with, or nothing when the queue is free (CLI-40). */
  readonly busy: () => string | undefined
}

export const make = (): Queue => {
  const semaphore = Semaphore.makeUnsafe(1)
  let running: string | undefined
  return {
    run: (effect, label = "a command") =>
      semaphore.withPermit(
        Effect.suspend(() => {
          running = label
          return effect
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              running = undefined
            }),
          ),
        ),
      ),
    busy: () => running,
  }
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
