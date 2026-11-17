import { Effect } from "effect"
import { Command } from "effect/cli"
import * as Repository from "../Repository.ts"

/** `chad check`: every check of an apply, with nothing committed and nothing loaded. */
export const check = Command.make(
  "check",
  {},
  Effect.fn("check")(function* () {
    return yield* Repository.through("check", { _tag: "Check" })
  }),
).pipe(Command.withDescription("Check what the repo holds without applying it"))
