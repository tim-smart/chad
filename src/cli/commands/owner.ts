import { Console, Effect } from "effect"
import { Argument, Command } from "effect/cli"
import * as Messages from "../../Messages.ts"
import * as Change from "../Change.ts"
import * as Flags from "../Flags.ts"

/** The `owner` commands. An owner is an id on a connection's list and nothing else. */

const connection = Argument.String("connection").pipe(
  Argument.withDescription("The connection's name"),
)

const id = Argument.String("id").pipe(
  Argument.withDescription(
    "The user id the platform sends as a message's author",
  ),
)

const add = Command.make(
  "add",
  { connection, id },
  Effect.fn("owner add")(function* ({ connection, id }) {
    const made = yield* Change.make("owner add", {
      _tag: "OwnerAdd",
      name: connection,
      id,
    })
    yield* Console.log(
      made.changed
        ? Messages.ownerAdded(id, connection)
        : Messages.ownerListed(id, connection),
    )
  }),
).pipe(Command.withDescription("Let a user talk to chad on a connection"))

const remove = Command.make(
  "remove",
  { connection, id, force: Flags.boolean("force") },
  Effect.fn("owner remove")(function* ({ connection, id, force }) {
    const made = yield* Change.make("owner remove", {
      _tag: "OwnerRemove",
      name: connection,
      id,
      force,
    })
    yield* Console.log(
      made.changed
        ? Messages.ownerRemoved(id, connection)
        : Messages.ownerUnlisted(id, connection),
    )
  }),
).pipe(Command.withDescription("Take a user off a connection's owner list"))

export const owner = Command.make("owner").pipe(
  Command.withDescription("Manage who may talk to chad"),
  Command.withSubcommands([add, remove]),
)
