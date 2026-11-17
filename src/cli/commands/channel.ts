import { Console, Effect } from "effect"
import { Argument, Command } from "effect/cli"
import * as Messages from "../../Messages.ts"
import * as Change from "../Change.ts"

/**
 * The `channel` commands. A channel on a connection's list needs no mention: an owner's message there is read as if it
 * mentioned chad. Who may talk to chad stays the owner list.
 */

const connection = Argument.String("connection").pipe(
  Argument.withDescription("The connection's name"),
)

const id = Argument.String("id").pipe(
  Argument.withDescription(
    "The id of the channel or thread, as the platform sends it, such as a Discord channel id",
  ),
)

const add = Command.make(
  "add",
  { connection, id },
  Effect.fn("channel add")(function* ({ connection, id }) {
    const made = yield* Change.make("channel add", {
      _tag: "ChannelAdd",
      name: connection,
      id,
    })
    yield* Console.log(
      made.changed
        ? Messages.channelAdded(id, connection)
        : Messages.channelListed(id, connection),
    )
  }),
).pipe(
  Command.withDescription(
    "Let an owner's message in a channel reach chad without a mention",
  ),
)

const remove = Command.make(
  "remove",
  { connection, id },
  Effect.fn("channel remove")(function* ({ connection, id }) {
    const made = yield* Change.make("channel remove", {
      _tag: "ChannelRemove",
      name: connection,
      id,
    })
    yield* Console.log(
      made.changed
        ? Messages.channelRemoved(id, connection)
        : Messages.channelUnlisted(id, connection),
    )
  }),
).pipe(Command.withDescription("Make a channel need a mention again"))

export const channel = Command.make("channel").pipe(
  Command.withDescription("Manage the channels that need no mention"),
  Command.withSubcommands([add, remove]),
)
