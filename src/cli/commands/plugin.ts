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

/**
 * `chad plugin purge <name>`: drops the data of a plugin that is gone from the applied repo, or a bundled one that is
 * off. It needs the daemon, which runs it in its queue (CLI-90, CLI-158, SET-40, SET-95).
 */
const purge = Command.make(
  "purge",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("The plugin's name"),
    ),
  },
  Effect.fn("plugin.purge")(function* ({ name }) {
    return yield* Repository.through("plugin purge", { _tag: "Purge", name })
  }),
).pipe(
  Command.withDescription("Delete the stored data of a plugin that is gone"),
)

/** `chad plugin`: one plugin at a time. */
export const plugin = Command.make("plugin").pipe(
  Command.withDescription("Manage one plugin"),
  Command.withSubcommands([reload, purge]),
)
