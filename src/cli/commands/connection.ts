import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import * as Connections from "../../Connections.ts"
import * as Discord from "../../Discord.ts"
import * as Messages from "../../Messages.ts"
import * as Change from "../Change.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Flags from "../Flags.ts"
import * as Owner from "../Owner.ts"
import * as Token from "../Token.ts"

/** The `connection` commands. Each is an owner command, and none takes a token as an argument. */

const tokenFile = Flag.String("token-file").pipe(
  Flag.withDescription("A file that holds the bot token"),
  Flag.optional,
)

const name = Argument.String("name").pipe(
  Argument.withDescription("The connection's name"),
)

/** The name a new connection gets, which is its platform unless one is given. */
const named = (kind: Connections.Kind) =>
  Flag.String("name").pipe(
    Flag.withDescription(
      "The connection's name, when it is not the platform's",
    ),
    Flag.withDefault(kind),
  )

const discord = Command.make(
  "discord",
  { name: named("discord"), tokenFile },
  Effect.fn("connection add discord")(function* ({ name, tokenFile }) {
    const command = "connection add"
    const made = yield* Change.make(
      command,
      { _tag: "Add", name, kind: "discord" },
      Token.read(command, tokenFile),
    )
    yield* Console.log(Messages.connectionAdded(name, "discord"))
    if (made.application !== undefined) {
      yield* Console.log(
        Messages.connectionInvite(Discord.inviteUrl(made.application)),
      )
    }
    yield* Console.log(
      Messages.connectionIntents(Discord.privilegedIntentNames),
    )
  }),
).pipe(Command.withDescription("Add a Discord bot"))

const local = Command.make(
  "local",
  { name: named("local") },
  Effect.fn("connection add local")(function* ({ name }) {
    yield* Change.make("connection add", { _tag: "Add", name, kind: "local" })
    yield* Console.log(Messages.connectionAdded(name, "local"))
  }),
).pipe(Command.withDescription("Add the adapter for development and tests"))

const add = Command.make("add").pipe(
  Command.withDescription("Add a chat connection"),
  Command.withSubcommands([discord, local]),
)

const list = Command.make(
  "list",
  {},
  Effect.fn("connection list")(
    function* () {
      const command = "connection list"
      yield* Owner.only(command)
      const environment = yield* Environment
      const connections =
        (yield* Daemon.lock) === "held"
          ? yield* Daemon.call(
              command,
              (yield* Daemon.reach(command)).ConnectionList(),
            )
          : Connections.listed(yield* Connections.read(environment.data))
      if (connections.length === 0) {
        return yield* Console.log(Messages.noConnections())
      }
      for (const { name, kind, owners } of connections) {
        yield* Console.log(Messages.connectionLine(name, kind, owners))
      }
    },
    Effect.mapError(Change.rejected("connection list")),
  ),
).pipe(Command.withDescription("List the chat connections and their owners"))

const check = Command.make(
  "check",
  { name: Argument.optional(name) },
  Effect.fn("connection check")(
    function* ({ name }) {
      const command = "connection check"
      yield* Owner.only(command)
      const environment = yield* Environment
      const chosen = Option.getOrUndefined(name)
      const lines =
        (yield* Daemon.lock) === "held"
          ? yield* Daemon.call(
              command,
              (yield* Daemon.reach(command)).ConnectionCheck(
                chosen === undefined ? {} : { name: chosen },
              ),
            )
          : yield* Connections.check(
              yield* Connections.read(environment.data),
              environment.data,
              chosen,
            )
      if (lines.length === 0) {
        return yield* Console.log(Messages.noConnections())
      }
      for (const line of lines) {
        yield* Console.log(
          Messages.connectionChecked(
            line.name,
            line.kind,
            line.result,
            line.detail,
          ),
        )
      }
      if (lines.some((line) => line.result !== "ok")) {
        return yield* new Failure({ code: ExitCode.failed })
      }
    },
    Effect.mapError(Change.rejected("connection check")),
  ),
).pipe(
  Command.withDescription("Check that each connection can reach its platform"),
)

const token = Command.make(
  "token",
  { name, tokenFile },
  Effect.fn("connection token")(function* ({ name, tokenFile }) {
    const command = "connection token"
    yield* Change.make(
      command,
      { _tag: "Token", name, token: "" },
      Token.read(command, tokenFile),
    )
    yield* Console.log(Messages.connectionToken(name))
  }),
).pipe(Command.withDescription("Give a connection a new token"))

const remove = Command.make(
  "remove",
  { name, force: Flags.boolean("force") },
  Effect.fn("connection remove")(function* ({ name, force }) {
    yield* Change.make("connection remove", { _tag: "Remove", name, force })
    yield* Console.log(Messages.connectionRemoved(name))
  }),
).pipe(Command.withDescription("Remove a connection"))

export const connection = Command.make("connection").pipe(
  Command.withDescription("Manage the chat connections"),
  Command.withSubcommands([add, list, check, token, remove]),
)
