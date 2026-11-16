import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import * as Repository from "../Repository.ts"

/** `chad revert [<commit>]`: applies an earlier applied commit's tree as a new commit, saving `work/` first (REC-82). */
export const revert = Command.make(
  "revert",
  {
    commit: Argument.String("commit").pipe(
      Argument.withDescription(
        "The applied commit to go back to, the one before the current one unless given",
      ),
      Argument.optional,
    ),
  },
  Effect.fn("revert")(function* ({ commit }) {
    return yield* Repository.through("revert", {
      _tag: "Revert",
      commit: Option.getOrUndefined(commit),
    })
  }),
).pipe(Command.withDescription("Go back to an earlier applied commit"))
