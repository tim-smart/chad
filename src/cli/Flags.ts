import { Flag } from "effect/cli"

/**
 * A boolean flag, which is off unless it is given. Every boolean flag of chad is declared through here, because
 * effect's CLI module treats a boolean flag with no default as one that has to be given.
 */
export const boolean = (name: string) =>
  Flag.Boolean(name).pipe(Flag.withDefault(false))
