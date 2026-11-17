import { Console, Effect } from "effect"
import { Command, Flag } from "effect/cli"
import * as Messages from "../../Messages.ts"
import * as Repo from "../../Repo.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Flags from "../Flags.ts"
import * as Repository from "../Repository.ts"

/** The commits `chad log` prints when no `--limit` is given. */
const last = 20

/** `chad log`: the applied commits, newest first, read from the repo alone with no daemon. */
export const log = Command.make(
  "log",
  {
    limit: Flag.Int("limit").pipe(
      Flag.withDescription(`The most commits to print, ${last} unless given`),
      Flag.filter((limit) => limit >= 1, Messages.dbLimit),
      Flag.withDefault(last),
    ),
    json: Flags.boolean("json").pipe(
      Flag.withDescription("Print the commits as JSON"),
    ),
  },
  Effect.fn("log")(function* ({ limit, json }) {
    const environment = yield* Environment
    const entries = yield* Repo.log(
      Repository.repoOf(environment.data),
      limit,
    ).pipe(
      Effect.mapError(
        () =>
          new Failure({ code: ExitCode.failed, message: Messages.logMissing }),
      ),
    )
    if (json) return yield* Console.log(JSON.stringify(entries))
    for (const entry of entries) {
      yield* Console.log(
        `${entry.commit.slice(0, 7)}  ${entry.time}  ${entry.session}  ${entry.message}`,
      )
    }
  }),
).pipe(Command.withDescription("List the applied commits"))
