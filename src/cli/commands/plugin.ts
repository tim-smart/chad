import { join } from "node:path"
import { Console, Effect, FileSystem } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import * as BundledNames from "../../BundledNames.ts"
import * as Errno from "../../Errno.ts"
import * as Messages from "../../Messages.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Flags from "../Flags.ts"
import * as Repository from "../Repository.ts"
import * as Starter from "../Starter.ts"

/** The name rule of every plugin in the repo (CLI-85, LOAD-92). */
const named = /^[a-z0-9-]+$/

/**
 * `chad plugin new <name> [--dir]`: writes the starter file into `work/` in this process, whether or not a daemon runs,
 * and does nothing else (CLI-84 to CLI-87, CLI-156, CLI-157, SELF-47 to SELF-52).
 */
const create = Command.make(
  "new",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription(
        "The plugin's name: lower-case letters, digits and hyphens",
      ),
    ),
    dir: Flags.boolean("dir").pipe(
      Flag.withDescription(
        "Write plugins/<name>/index.ts in place of plugins/<name>.ts",
      ),
    ),
  },
  Effect.fn("plugin.new")(function* ({ name, dir }) {
    const failed = (code: ExitCode, message: string) =>
      new Failure({ code, message })
    if (!named.test(name)) {
      return yield* failed(ExitCode.usage, Messages.pluginNameInvalid(name))
    }
    if ((BundledNames.plugins as ReadonlyArray<string>).includes(name)) {
      return yield* failed(ExitCode.failed, Messages.pluginNameBundled(name))
    }
    const environment = yield* Environment
    const fs = yield* FileSystem.FileSystem
    const repo = Repository.repoOf(environment.data)
    const work = join(repo, "work")
    const exists = (path: string) =>
      fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))
    if (!(yield* exists(work))) {
      return yield* failed(ExitCode.daemon, Messages.workMissing(work))
    }
    const plugins = join(work, "plugins")
    if (
      (yield* exists(join(plugins, `${name}.ts`))) ||
      (yield* exists(join(plugins, name)))
    ) {
      return yield* failed(ExitCode.failed, Messages.pluginNameTaken(name))
    }
    const path = dir
      ? join(plugins, name, "index.ts")
      : join(plugins, `${name}.ts`)
    yield* Files.scaffold(
      "plugin new",
      Effect.gen(function* () {
        yield* fs.makeDirectory(dir ? join(plugins, name) : plugins, {
          recursive: true,
        })
        // "wx" refuses a file another writer made since the test above.
        yield* fs.writeFileString(path, Starter.file({ name, repo, dir }), {
          flag: "wx",
        })
      }),
    ).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          Errno.code(error) === "EEXIST"
            ? failed(ExitCode.failed, Messages.pluginNameTaken(name))
            : failed(
                ExitCode.failed,
                Messages.notWritten("plugin new", path, Errno.code(error)),
              ),
        ),
      ),
    )
    yield* Console.log(
      Messages.pluginWritten(
        path,
        join(repo, "node_modules/effect/AGENTS.md"),
        join(repo, "examples") + "/",
      ),
    )
  }),
).pipe(Command.withDescription("Write a starter plugin into work/"))

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
  Command.withSubcommands([create, reload, purge]),
)
