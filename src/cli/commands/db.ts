import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import * as Messages from "../../Messages.ts"
import * as Paths from "../../Paths.ts"
import * as Database from "../Database.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Flags from "../Flags.ts"

/** The rows `chad db query` prints when no `--limit` is given. */
const rows = 200

/** Runs one statement on the CLI's own read-only connection. A statement that SQLite fails ends the command. */
const read = Effect.fn("db.read")(function* (
  command: "query" | "check",
  sql: string,
  limit: number,
) {
  const environment = yield* Environment
  return yield* Effect.try({
    try: () => Database.query(Paths.database(environment.data), sql, limit),
    catch: (error) =>
      new Failure({
        code: ExitCode.failed,
        message:
          error instanceof Database.Missing
            ? Messages.dbMissing(command, error.path)
            : Messages.dbFailed(
                command,
                error instanceof Error ? error.message : String(error),
              ),
      }),
  })
})

/** `chad db query`: one statement, read-only, with or without a daemon. */
const query = Command.make(
  "query",
  {
    sql: Argument.String("sql").pipe(
      Argument.withDescription("The statement to run"),
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription(`The most rows to print, ${rows} unless given`),
      Flag.filter((limit) => limit >= 1, Messages.dbLimit),
      Flag.withDefault(rows),
    ),
    json: Flags.boolean("json").pipe(
      Flag.withDescription("Print the rows as JSON"),
    ),
  },
  Effect.fn("db.query")(function* ({ sql, limit, json }) {
    const found = yield* read("query", sql, limit)
    yield* Console.log(json ? Database.json(found) : Database.text(found))
    if (found.more) yield* Console.error(Messages.dbMore(limit))
  }),
).pipe(Command.withDescription("Run one read-only statement on the database"))

/** `chad db check`: SQLite's integrity check, printed as SQLite gives it. */
const check = Command.make(
  "check",
  {},
  Effect.fn("db.check")(function* () {
    const found = yield* read("check", "PRAGMA integrity_check", Infinity)
    const lines = found.rows.map((row) => String(row[0]))
    yield* Console.log(lines.join("\n"))
    // A database that passes gives the one line `ok`.
    if (lines.length !== 1 || lines[0] !== "ok") {
      return yield* new Failure({ code: ExitCode.failed })
    }
  }),
).pipe(Command.withDescription("Check the integrity of the database"))

/** `chad db`: the database, read in the CLI's own process. */
export const db = Command.make("db").pipe(
  Command.withDescription("Read the database"),
  Command.withSubcommands([query, check]),
)
