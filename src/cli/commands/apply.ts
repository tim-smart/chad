import { Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import * as Repository from "../Repository.ts"

/**
 * `chad apply -m <why> [--expect <tree>]`: commits what `work/` holds and loads it, or changes nothing. With
 * `--expect` it applies only when what `work/` holds is that tree, so a change made after the caller looked is never
 * published with its own.
 */
export const apply = Command.make(
  "apply",
  {
    message: Flag.String("message").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("Why, which becomes the commit message"),
    ),
    expect: Flag.String("expect").pipe(
      Flag.withDescription(
        "The tree work/ must hold, as git write-tree gives it, or nothing is applied",
      ),
      Flag.optional,
    ),
  },
  Effect.fn("apply")(function* ({ message, expect }) {
    return yield* Repository.through("apply", {
      _tag: "Apply",
      message,
      expect: Option.getOrUndefined(expect),
    })
  }),
).pipe(Command.withDescription("Check, commit and load what the repo holds"))
