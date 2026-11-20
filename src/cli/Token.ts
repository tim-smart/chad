import { Effect, FileSystem, Option, Redacted, Stdio, Stream } from "effect"
import { Prompt } from "effect/cli"
import * as Errno from "../Errno.ts"
import * as Messages from "../Messages.ts"
import { ExitCode, Failure } from "./Failure.ts"

/**
 * What the owner enters in secret: all of stdin when it is not a terminal, and the answer to a prompt that echoes
 * nothing otherwise.
 */
export const entered = Effect.fnUntraced(function* (prompt: string) {
  const stdio = yield* Stdio.Stdio
  if (yield* stdio.stdinIsTerminal) {
    return yield* Prompt.run(Prompt.Hidden({ message: prompt })).pipe(
      Effect.map(Redacted.value),
      // Ctrl-C at the prompt ends the command as a signal does.
      Effect.mapError(() => new Failure({ code: ExitCode.interrupted })),
    )
  }
  return yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orDie,
  )
})

/**
 * Reads a token for a command. It comes from the file when one is named, from stdin when stdin is not a terminal, and
 * from a prompt that echoes nothing otherwise. A token is never a command argument and never comes from the
 * environment.
 */
export const read = Effect.fn("Token.read")(function* (
  command: string,
  file: Option.Option<string>,
) {
  let token: string
  if (Option.isSome(file)) {
    const fs = yield* FileSystem.FileSystem
    token = yield* fs.readFileString(file.value).pipe(
      Effect.mapError(
        (error) =>
          new Failure({
            code: ExitCode.failed,
            message: Messages.unreadable(
              command,
              file.value,
              Errno.code(error),
            ),
          }),
      ),
    )
  } else {
    token = yield* entered(Messages.tokenPrompt())
  }
  token = token.trim()
  if (token === "") {
    return yield* new Failure({
      code: ExitCode.usage,
      message: Messages.noToken(command),
    })
  }
  return token
})
