import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Cause, Console, Effect, Layer } from "effect"
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from "effect/cli"
import type { HttpClient } from "effect/http"
import { RpcClient } from "effect/rpc"
import { Timings } from "../Timings.ts"
import { version } from "../Version.ts"
import { commands } from "./Commands.ts"
import * as Daemon from "./Daemon.ts"
import * as Environment from "./Environment.ts"
import { ExitCode, Failure } from "./Failure.ts"

/** The outside world of a client command. Everything else is read from the process environment when `runCli` starts. */
export interface CliInputs {
  /** The words after `chad` on the command line. */
  readonly args: ReadonlyArray<string>
  /** The client every request the CLI makes by itself goes through. */
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  /** One complete set of durations. */
  readonly timings: Timings
}

const root = Command.make("chad").pipe(
  Command.withDescription("chad, a personal assistant that edits itself"),
  Command.withSubcommands(commands),
)

/** Resolves on the first SIGINT or SIGTERM, and takes its handlers off the process when it is done with. */
const signalled = Effect.callback<void>((resume) => {
  const off = () => {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
  const stop = () => {
    off()
    resume(Effect.void)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  return Effect.sync(off)
})

/** The exit code of a command that did not end well. effect's CLI module has printed a usage error by now. */
const ended = (error: unknown): Effect.Effect<ExitCode> => {
  if (error instanceof Failure) {
    return error.message === ""
      ? Effect.succeed(error.code)
      : Effect.as(Console.error(error.message), error.code)
  }
  if (CliError.isCliError(error)) {
    // Help that was asked for by running a group with no command is no error.
    const help = error._tag === "ShowHelp" && error.errors.length === 0
    return Effect.succeed(help ? ExitCode.done : ExitCode.usage)
  }
  return Effect.as(Console.error(String(error)), ExitCode.failed)
}

/**
 * Runs one client command and gives its exit code. It owns the signals, so a command that a signal ends gives 130,
 * and it never exits the process itself.
 */
export const runCli = (inputs: CliInputs): Promise<ExitCode> => {
  const environment = Environment.read(process.env)
  const services = Layer.mergeAll(
    NodeServices.layer,
    inputs.httpClient,
    // The socket a Codex trial request of `chad model` with no daemon dials (MOD-90). It is no input of `runCli`, which
    // takes an HttpClient and the durations only (TST-209).
    NodeSocket.layerWebSocketConstructor,
    Layer.succeed(Environment.Environment, environment),
    Layer.succeed(Timings, inputs.timings),
    // Of the flags effect adds by itself, chad keeps --help and --version.
    CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
    // Colour is for a terminal, whatever the environment asks for.
    CliOutput.layer(
      CliOutput.defaultFormatter({ colors: process.stdout.isTTY === true }),
    ),
  )
  const program = Command.runWith(root, { version })(inputs.args).pipe(
    RpcClient.withHeaders(Daemon.headers(environment.session)),
    Effect.scoped,
    Effect.as<ExitCode>(ExitCode.done),
    Effect.catch(ended),
    Effect.catchCause((cause) =>
      Effect.as(Console.error(Cause.pretty(cause)), ExitCode.failed),
    ),
    Effect.raceFirst(Effect.as(signalled, ExitCode.interrupted)),
    Effect.provide(services),
  )
  return Effect.runPromise(program)
}
