import { Effect } from "effect"
import { Command, Flag } from "effect/cli"
import * as Repository from "../Repository.ts"

/** `chad apply -m <why>`: commits what `work/` holds and loads it, or changes nothing. */
export const apply = Command.make(
  "apply",
  {
    message: Flag.String("message").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("Why, which becomes the commit message"),
    ),
  },
  Effect.fn("apply")(function* ({ message }) {
    return yield* Repository.through("apply", { _tag: "Apply", message })
  }),
).pipe(Command.withDescription("Check, commit and load what the repo holds"))
