import { Console, Effect, Option, Redacted, Stdio } from "effect"
import { Command, Flag, Prompt } from "effect/cli"
import * as Connections from "../../Connections.ts"
import * as Discord from "../../Discord.ts"
import * as Messages from "../../Messages.ts"
import * as Timezone from "../../Timezone.ts"
import * as Account from "../Account.ts"
import * as Change from "../Change.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Flags from "../Flags.ts"
import * as Owner from "../Owner.ts"
import * as Token from "../Token.ts"
import * as Login from "./login.ts"
import * as TimezoneCommand from "./timezone.ts"

const command = "setup"

/** Ctrl-C at a prompt ends the command as a signal does. */
const ask = <A>(prompt: Prompt.Prompt<A>) =>
  Prompt.run(prompt).pipe(
    Effect.mapError(() => new Failure({ code: ExitCode.interrupted })),
  )

/** The stored connections, from the daemon when one runs, without their tokens. */
const listed = Effect.gen(function* () {
  const environment = yield* Environment
  if ((yield* Daemon.lock) === "held") {
    const client = yield* Daemon.reach(command)
    return yield* Daemon.call(command, client.ConnectionList())
  }
  return Connections.listed(yield* Connections.read(environment.data))
}).pipe(Effect.mapError(Change.rejected(command)))

/** The name of the bot a stored token belongs to, by the check `chad connection check` makes, or nothing. */
const storedBot = (name: string) =>
  Effect.gen(function* () {
    const environment = yield* Environment
    const lines =
      (yield* Daemon.lock) === "held"
        ? yield* Daemon.call(
            command,
            (yield* Daemon.reach(command)).ConnectionCheck({ name }),
          )
        : yield* Connections.check(
            yield* Connections.read(environment.data),
            environment.data,
            name,
          )
    return lines[0]?.bot
  }).pipe(Effect.orElseSucceed(() => undefined))

/**
 * `chad setup`: a wizard over `connection add discord` or `connection token`, `owner add`, `timezone` and `login`.
 * Each question has a flag, shows what is stored and keeps it on an empty answer, and a run after the first only adds
 * or replaces.
 */
export const setup = Command.make(
  command,
  {
    tokenFile: Flag.String("discord-token-file").pipe(
      Flag.withDescription("A file that holds the Discord bot token"),
      Flag.optional,
    ),
    owner: Flag.String("owner").pipe(
      Flag.withDescription("The owner's Discord user id"),
      Flag.optional,
    ),
    timezone: Flag.String("timezone").pipe(
      Flag.withDescription("The owner's timezone, an IANA name"),
      Flag.optional,
    ),
    skipLogin: Flags.boolean("skip-login").pipe(
      Flag.withDescription("Skip the model login"),
    ),
  },
  Effect.fn("setup")(function* ({
    tokenFile,
    owner: flag,
    timezone,
    skipLogin,
  }) {
    yield* Owner.only(command)
    // A blank `--owner` is no answer, so it is missing like one not given.
    const owner = flag.pipe(
      Option.map((id) => id.trim()),
      Option.filter((id) => id !== ""),
    )
    const environment = yield* Environment
    const terminal = yield* (yield* Stdio.Stdio).stdinIsTerminal
    // A zone that is no zone stops setup before it changes anything.
    const zone = Option.isSome(timezone)
      ? yield* TimezoneCommand.parse(timezone.value)
      : undefined
    if ((yield* Daemon.lock) === "free") yield* Files.writable(command)
    const current = (yield* listed).find(({ kind }) => kind === "discord")
    const login = yield* Account.fromFiles

    // With no terminal, an answer that is neither given nor stored fails before anything changes.
    if (!terminal) {
      const missing = [
        ...(current === undefined && Option.isNone(tokenFile)
          ? ["--discord-token-file"]
          : []),
        ...((current?.owners.length ?? 0) === 0 && Option.isNone(owner)
          ? ["--owner"]
          : []),
        ...(login.login === "logged-out" && !skipLogin ? ["--skip-login"] : []),
      ]
      if (missing.length > 0) {
        return yield* new Failure({
          code: ExitCode.usage,
          message: Messages.setupMissing(missing),
        })
      }
    }

    // The token: never printed, a stored one named by its bot.
    const name = current?.name ?? "discord"
    if (current !== undefined) {
      yield* Console.log(
        Messages.setupTokenStored(name, yield* storedBot(name)),
      )
    }
    const token = Option.isSome(tokenFile)
      ? yield* Token.read(command, tokenFile)
      : !terminal
        ? undefined
        : current === undefined
          ? yield* Token.read(command, Option.none())
          : yield* ask(
              Prompt.Hidden({ message: Messages.setupTokenPrompt }),
            ).pipe(
              Effect.map((typed) => Redacted.value(typed).trim() || undefined),
            )
    if (token !== undefined) {
      const made = yield* Change.make(
        command,
        current === undefined
          ? { _tag: "Add", name, kind: "discord" }
          : { _tag: "Token", name, token: "" },
        Effect.succeed(token),
      )
      if (current === undefined) {
        yield* Console.log(Messages.connectionAdded(name, "discord"))
        if (made.application !== undefined) {
          yield* Console.log(
            Messages.connectionInvite(Discord.inviteUrl(made.application)),
          )
        }
      } else {
        yield* Console.log(Messages.connectionToken(name))
      }
      // The message content intent, which Discord lets an app in fewer than 100 servers turn on itself.
      const checked = yield* Discord.checkToken(token).pipe(Effect.option)
      const switched = Option.isSome(checked)
        ? yield* Discord.messageContent(token, checked.value.flags)
        : "portal"
      if (Option.isSome(checked) && checked.value.bot !== undefined) {
        yield* Console.log(Messages.setupBot(checked.value.bot))
      }
      yield* Console.log(
        Messages.setupIntent(
          switched,
          Option.isSome(checked) ? checked.value.application : made.application,
        ),
      )
    }

    // The owner: `--owner` is given once, and a stored owner stays.
    const owners = current?.owners ?? []
    const id = Option.isSome(owner)
      ? owner.value
      : !terminal
        ? ""
        : yield* ask(
            Prompt.String({
              message: Messages.setupOwnerPrompt(owners),
              validate: (answer) =>
                answer.trim() === "" && owners.length === 0
                  ? Effect.fail(Messages.setupOwnerNeeded)
                  : Effect.succeed(answer.trim()),
            }),
          )
    if (id !== "") {
      const made = yield* Change.make(command, {
        _tag: "OwnerAdd",
        name,
        id,
      })
      yield* Console.log(
        made.changed
          ? Messages.ownerAdded(id, name)
          : Messages.ownerListed(id, name),
      )
    } else {
      yield* Console.log(Messages.setupOwnersKept(owners, name))
    }

    // The timezone: a zone is always in force, so an empty answer keeps it and nothing is missing.
    const inForce = yield* Timezone.read(environment.data, environment.tz)
    const next =
      zone !== undefined
        ? zone
        : !terminal
          ? undefined
          : yield* ask(
              Prompt.String({
                message: Messages.setupTimezonePrompt(inForce.zone),
                validate: (answer) => {
                  if (answer.trim() === "") return Effect.succeed("")
                  const canonical = Timezone.canonical(answer)
                  return canonical === undefined
                    ? Effect.fail(Messages.timezoneInvalid(answer))
                    : Effect.succeed(canonical)
                },
              }),
            ).pipe(Effect.map((answer) => answer || undefined))
    if (
      next !== undefined &&
      !(inForce.source === "stored" && inForce.zone === next)
    ) {
      yield* TimezoneCommand.store(next)
    } else {
      yield* Console.log(
        Messages.timezoneInForce(inForce.zone, inForce.source, inForce.ignored),
      )
    }

    // The model login, which `--skip-login` skips.
    if (skipLogin) return yield* Console.log(Messages.setupLoginSkipped)
    if (login.login === "not-needed")
      return yield* Console.log(Messages.loginNotNeeded(login.spec))
    if (login.login === "logged-in")
      return yield* Console.log(Messages.setupLoggedIn)
    const now = yield* ask(
      Prompt.Confirm({ message: Messages.setupLoginOffer, initial: true }),
    )
    if (!now) return yield* Console.log(Messages.setupLoginSkipped)
    return yield* (yield* Daemon.lock) === "held"
      ? Login.throughDaemon
      : Login.alone
  }),
).pipe(
  Command.withDescription(
    "Set chad up: the bot, the owner, the timezone and the login",
  ),
)
