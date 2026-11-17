import { spawn } from "node:child_process"
import { constants } from "node:os"
import { Console, Effect, Option, Redacted, Stdio, Stream } from "effect"
import { Argument, Command, Flag, Prompt } from "effect/cli"
import * as Errno from "../../Errno.ts"
import * as Messages from "../../Messages.ts"
import * as Secrets from "../../Secrets.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Flags from "../Flags.ts"
import * as Repository from "../Repository.ts"

/**
 * `chad secret`: the named values in `secrets/secrets.json`. No command prints a stored value, and
 * there is no `get`.
 */

/** The exit codes of `chad secret run`'s own failures, which a child rarely returns. */
/** The codes `chad secret run` exits with for its own failures. */
export const RunCode = {
  usage: 125,
  notExecutable: 126,
  notFound: 127,
} as const

/** A store that cannot be read or holds no store ends the command with exit 1, naming the file and nothing it holds. */
const broken = (command: string) => (error: Secrets.SecretsError) =>
  new Failure({
    code: ExitCode.failed,
    message: Messages.secretStoreBroken(command, error.message),
  })

/**
 * The value, from stdin when it is not a terminal and from a prompt that echoes nothing otherwise, and never from an
 * argument. One line ending at the end is dropped, which `echo` adds, and nothing else.
 */
const value = (name: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const read = (yield* stdio.stdinIsTerminal)
      ? yield* Prompt.run(
          Prompt.Hidden({ message: Messages.secretPrompt(name) }),
        ).pipe(
          Effect.map(Redacted.value),
          // Ctrl-C at the prompt ends the command as a signal does.
          Effect.mapError(() => new Failure({ code: ExitCode.interrupted })),
        )
      : yield* stdio.stdin.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.orDie,
        )
    const text = read.replace(/\r?\n$/, "")
    if (text === "")
      return yield* new Failure({
        code: ExitCode.usage,
        message: Messages.secretNoValue(),
      })
    return text
  })

/**
 * A change to the store. With a daemon it goes through the daemon's queue, which reloads the plugins that name the
 * secret. With none the CLI writes the file itself under the lock, by temporary file and rename, and
 * the next start reads it. With no daemon nothing writes a `command.ran` line.
 */
const change = (
  command: "set" | "rm",
  request: Extract<
    Parameters<typeof Repository.through>[1],
    { readonly _tag: "SecretSet" | "SecretRm" }
  >,
  printed: (
    changed: Exclude<Secrets.Changed, { readonly _tag: "Missing" }>,
  ) => string,
) =>
  Effect.gen(function* () {
    const label = `secret ${command}`
    if ((yield* Daemon.lock) === "held")
      return yield* Repository.through(label, request)
    const environment = yield* Environment
    yield* Files.writable(label)
    const changed = yield* Files.locked(
      label,
      Effect.gen(function* () {
        yield* Files.writable(label)
        return yield* Secrets.change(environment.data, (store) =>
          request._tag === "SecretSet"
            ? Secrets.save(
                store,
                request.name,
                request.value,
                request.note,
                new Date(),
              )
            : Secrets.remove(store, request.name),
        ).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(
              new Secrets.SecretsError({
                message: `secrets/secrets.json cannot be written (${Errno.code(error)})`,
              }),
            ),
          ),
          Effect.mapError(broken(command)),
        )
      }),
    )
    if (changed._tag === "Missing")
      return yield* new Failure({
        code: ExitCode.failed,
        message: Messages.secretMissing("rm", request.name),
      })
    yield* Console.log(printed(changed))
  })

/** `chad secret set <NAME> [--note <text>]`. */
const set = Command.make(
  "set",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("The secret's name, such as GITHUB_TOKEN"),
    ),
    note: Flag.String("note").pipe(
      Flag.withDescription(
        'A note, such as the site and the username. "" clears it, and with none the stored note stays',
      ),
      Flag.optional,
    ),
  },
  Effect.fn("secret.set")(function* ({ name, note }) {
    if (!Secrets.valid(name))
      return yield* new Failure({
        code: ExitCode.usage,
        message:
          name === Secrets.RESERVED
            ? Messages.secretNameReserved()
            : Messages.secretNameInvalid(),
      })
    return yield* change(
      "set",
      {
        _tag: "SecretSet",
        name,
        value: yield* value(name),
        note: Option.getOrUndefined(note),
      },
      (changed) =>
        Messages.secretSaved(
          name,
          changed._tag === "Saved" && changed.replaced,
          [],
        ),
    )
  }),
).pipe(
  Command.withDescription("Store a secret, read from stdin or a hidden prompt"),
)

/** `chad secret list [--json]`: each name, note and date, never a value. */
const list = Command.make(
  "list",
  {
    json: Flags.boolean("json").pipe(
      Flag.withDescription("Print the list as JSON"),
    ),
  },
  Effect.fn("secret.list")(function* ({ json }) {
    const environment = yield* Environment
    const store = yield* Secrets.read(environment.data).pipe(
      Effect.mapError(broken("list")),
    )
    const listed = Object.keys(store)
      .sort()
      .map((name) => {
        const { note, date } = store[name]!
        return { name, ...(note === undefined ? {} : { note }), date }
      })
    if (json) return yield* Console.log(JSON.stringify(listed))
    yield* Console.log(
      listed.length === 0
        ? Messages.secretsNone()
        : listed
            .map(({ name, date, note }) =>
              Messages.secretListed(name, date, note),
            )
            .join("\n"),
    )
  }),
).pipe(Command.withDescription("List the stored secrets, with no value"))

/** `chad secret rm <NAME>`. */
const rm = Command.make(
  "rm",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("The secret's name"),
    ),
  },
  Effect.fn("secret.rm")(function* ({ name }) {
    return yield* change("rm", { _tag: "SecretRm", name }, () =>
      Messages.secretRemoved(name, []),
    )
  }),
).pipe(Command.withDescription("Delete a secret"))

/**
 * Runs a command and gives its exit code: the child's own, 128 and the signal's number for one a signal ended, 127
 * for a command that is not found and 126 for one that is found and cannot be executed.
 * The child inherits the CLI's stdio, but for stdin when `input` is given, which is written with no line ending and
 * then closed. A CLI that a signal ends takes its child with it.
 */
const execute = (
  inherited: Readonly<Record<string, string | undefined>>,
  command: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  input: string | undefined,
) =>
  Effect.callback<number, Failure>((resume) => {
    const child = spawn(command, args, {
      env: { ...inherited, ...env },
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    })
    let ended = false
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (ended) return
      ended = true
      resume(
        Effect.fail(
          error.code === "ENOENT"
            ? new Failure({
                code: RunCode.notFound,
                message: Messages.secretNotFound(command),
              })
            : new Failure({
                code: RunCode.notExecutable,
                message: Messages.secretNotExecutable(
                  command,
                  error.code ?? "unknown",
                ),
              }),
        ),
      )
    })
    child.once("exit", (code, signal) => {
      if (ended) return
      ended = true
      resume(
        Effect.succeed(
          code ??
            128 + (signal === null ? 0 : (constants.signals[signal] ?? 0)),
        ),
      )
    })
    if (input !== undefined && child.stdin !== null) {
      // A child that never reads its stdin closes the pipe, and that is no error of chad's.
      child.stdin.on("error", () => {})
      child.stdin.end(input)
    }
    return Effect.sync(() => {
      if (!ended) child.kill("SIGTERM")
    })
  })

/** A `VAR=NAME` pair of `--env`: a variable name, then a secret's name. */
const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/

/**
 * The one-off values the daemon holds for the turn whose key this CLI has, of the names it asks for. Only a process of
 * a session's running turn has a key, so the owner's shell and the processes of another session or an earlier turn get
 * none, and with no daemon there are none to get. A daemon that is not reached ends the command, so a stored value
 * never stands in for a one-off one.
 */
const oneOff = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { turnKey } = yield* Environment
    if (turnKey === undefined || names.length === 0) return {}
    if ((yield* Daemon.lock) === "free") return {}
    const client = yield* Daemon.reach("secret run")
    return yield* Daemon.call(
      "secret run",
      client.OnceValues({ key: turnKey, names }),
    )
  }).pipe(
    Effect.mapError(
      (failure) =>
        new Failure({ code: RunCode.usage, message: failure.message }),
    ),
  )

/**
 * `chad secret run [--env VAR=NAME]... [--stdin NAME] -- <command> [args]`. The CLI reads the store itself, with or
 * without a daemon, and puts each value only into the child's environment or stdin. A one-off value the daemon holds
 * for the command's session wins over a stored one of the same name. Its own failures exit 125, and otherwise the
 * child's code passes through.
 */
const runCommand = Command.make(
  "run",
  {
    env: Flag.String("env").pipe(
      Flag.withDescription("VAR=NAME: put secret NAME into variable VAR"),
      Flag.atLeast(0),
    ),
    stdin: Flag.String("stdin").pipe(
      Flag.withDescription("Write secret NAME to the command's stdin"),
      Flag.optional,
    ),
    command: Argument.String("command").pipe(
      Argument.withDescription("The command and its arguments, after --"),
      Argument.variadic({ min: 1 }),
    ),
  },
  Effect.fn("secret.run")(function* ({ env, stdin, command }) {
    const usage = (message: string) =>
      new Failure({ code: RunCode.usage, message })
    // effect's CLI module refuses a run with no command, and that usage error exits 125 (runCli.ts).
    const [program = "", ...args] = command
    const pairs: Array<readonly [string, string]> = []
    for (const given of env) {
      const match = pair.exec(given)
      if (match === null) return yield* usage(Messages.secretEnvPair(given))
      pairs.push([match[1]!, match[2]!])
    }
    const environment = yield* Environment
    const store = yield* Secrets.read(environment.data).pipe(
      Effect.mapError((error) =>
        usage(Messages.secretStoreBroken("run", error.message)),
      ),
    )
    const once = yield* oneOff([
      ...pairs.map(([, name]) => name),
      ...(Option.isSome(stdin) ? [stdin.value] : []),
    ])
    const lookup = (name: string) =>
      Object.hasOwn(once, name)
        ? Effect.succeed(once[name]!)
        : Object.hasOwn(store, name)
          ? Effect.succeed(store[name]!.value)
          : Effect.fail(usage(Messages.secretMissing("run", name)))
    const variables: Record<string, string> = {}
    for (const [variable, name] of pairs)
      variables[variable] = yield* lookup(name)
    const input = Option.isSome(stdin) ? yield* lookup(stdin.value) : undefined
    const code = yield* execute(
      environment.inherited,
      program,
      args,
      variables,
      input,
    )
    if (code !== 0) return yield* new Failure({ code, message: "" })
  }),
).pipe(
  Command.withDescription(
    "Run a command with secrets in its environment or on its stdin",
  ),
)

/** `chad secret`. */
export const secret = Command.make("secret").pipe(
  Command.withDescription("Store logins and hand them to commands"),
  Command.withSubcommands([set, list, rm, runCommand]),
)
