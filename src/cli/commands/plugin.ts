import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import * as Repository from "../Repository.ts"

/** `chad plugin reload <name>`: builds one plugin again and swaps it when the build succeeds (CLI-88, CLI-171). */
const reload = Command.make(
  "reload",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("The plugin's name"),
    ),
  },
  Effect.fn("plugin.reload")(function* ({ name }) {
    return yield* Repository.through("plugin reload", { _tag: "Reload", name })
  }),
).pipe(Command.withDescription("Build one plugin again"))

/** `chad plugin`: one plugin at a time. */
export const plugin = Command.make("plugin").pipe(
  Command.withDescription("Manage one plugin"),
  Command.withSubcommands([reload]),
)
