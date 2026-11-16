import { join } from "node:path"
import { Console, Effect, FileSystem } from "effect"
import { Argument, Command } from "effect/cli"
import * as Errno from "../../Errno.ts"
import * as Messages from "../../Messages.ts"
import * as Skills from "../../Skills.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"

/**
 * `chad skill new <name>`: writes `skills/<name>/SKILL.md` into `work/` in the CLI's own process, with or without a
 * daemon, and does nothing else, so the skill is a draft until an apply.
 */
const create = Command.make(
  "new",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription(
        "The skill's name: lower-case letters, digits and hyphens",
      ),
    ),
  },
  Effect.fn("skill.new")(function* ({ name }) {
    if (!Skills.validName(name)) {
      return yield* new Failure({
        code: ExitCode.usage,
        message: Messages.skillNameRule(name),
      })
    }
    const environment = yield* Environment
    const fs = yield* FileSystem.FileSystem
    const work = join(environment.data, "repo/work")
    if (!(yield* fs.exists(work))) {
      return yield* new Failure({
        code: ExitCode.daemon,
        message: Messages.skillNoRepo(work),
      })
    }
    const bundled = yield* Skills.scan(Skills.bundledDirectory)
    if (
      [...bundled.skills, ...bundled.bad].some((skill) => skill.name === name)
    ) {
      return yield* new Failure({
        code: ExitCode.failed,
        message: Messages.skillBundledName(name),
      })
    }
    const directory = join(work, "skills", name)
    if (yield* fs.exists(directory)) {
      return yield* new Failure({
        code: ExitCode.failed,
        message: Messages.skillTaken(name),
      })
    }
    const path = join(directory, Skills.fileName)
    yield* Files.scaffold(
      "skill new",
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true })
        // "wx" refuses a file another writer made since the test above.
        yield* fs.writeFileString(path, Skills.template(name), { flag: "wx" })
      }),
    ).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new Failure({
            code: ExitCode.failed,
            message:
              Errno.code(error) === "EEXIST"
                ? Messages.skillTaken(name)
                : Messages.notWritten("skill new", path, Errno.code(error)),
          }),
        ),
      ),
    )
    yield* Console.log(Messages.skillWritten(name))
  }),
).pipe(Command.withDescription("Write a new skill into work/"))

/** `chad skill`: one skill at a time. */
export const skill = Command.make("skill").pipe(
  Command.withDescription("Manage skills"),
  Command.withSubcommands([create]),
)
