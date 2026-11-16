import { Console, Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import * as Messages from "../../Messages.ts"
import * as Timezone from "../../Timezone.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Repository from "../Repository.ts"

/**
 * Stores a zone that is already known to be valid. With a daemon it stores it and reloads every plugin in its queue;
 * with none the CLI writes `state/timezone` under the lock, which the next start reads (CLI-35, CLI-113, CLI-114).
 */
export const store = (zone: string) =>
  Effect.gen(function* () {
    if ((yield* Daemon.lock) === "held") {
      return yield* Repository.through("timezone", { _tag: "Timezone", zone })
    }
    const environment = yield* Environment
    yield* Files.writable("timezone")
    yield* Files.locked(
      "timezone",
      Effect.gen(function* () {
        yield* Files.writable("timezone")
        yield* Timezone.write(environment.data, zone).pipe(
          Effect.mapError(
            (error) =>
              new Failure({ code: ExitCode.failed, message: error.message }),
          ),
        )
      }),
    )
    yield* Console.log(Messages.timezoneSet(zone))
  })

/** The zone `chad timezone` takes, by the name `Intl` resolves it to. Anything else exits 2 (CLI-182, CLI-183). */
export const parse = (zone: string) => {
  const canonical = Timezone.canonical(zone)
  return canonical === undefined
    ? Effect.fail(
        new Failure({
          code: ExitCode.usage,
          message: Messages.timezoneInvalid(zone),
        }),
      )
    : Effect.succeed(canonical)
}

/** `chad timezone [zone]`: prints the zone in force and where it came from, or stores a new one (CLI-113 to CLI-185). */
export const timezone = Command.make(
  "timezone",
  {
    zone: Argument.String("zone").pipe(
      Argument.withDescription("An IANA zone name, such as Europe/Berlin"),
      Argument.optional,
    ),
  },
  Effect.fn("timezone")(function* ({ zone }) {
    if (Option.isSome(zone)) return yield* store(yield* parse(zone.value))
    const environment = yield* Environment
    const inForce = yield* Timezone.read(environment.data, environment.tz)
    yield* Console.log(
      Messages.timezoneInForce(inForce.zone, inForce.source, inForce.ignored),
    )
  }),
).pipe(Command.withDescription("Show or set the owner's timezone"))
