import * as NodeServices from "@effect/platform-node/NodeServices"
import {
  type Cause,
  Effect,
  Layer,
  Option,
  Queue,
  Stdio,
  Terminal,
} from "effect"
import { expect, it } from "vitest"
import * as Token from "../../src/cli/Token.ts"
import * as Messages from "../../src/Messages.ts"
/** Reads a token at a terminal whose keys are the ones given, after which the input ends as it does on Ctrl-C. */
const typed = (text: string, enter: boolean) => {
  const shown: Array<string> = []
  const key = (name: string, input: Option.Option<string>) => ({
    input,
    key: { name, ctrl: false, meta: false, shift: false },
  })
  const terminal = Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("no size"),
      readLine: Effect.die("no line"),
      display: (text) => Effect.sync(() => void shown.push(text)),
      readInput: Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>()
        yield* Queue.offerAll(queue, [
          ...[...text].map((character) =>
            key(character, Option.some(character)),
          ),
          ...(enter ? [key("enter", Option.none())] : []),
        ])
        if (!enter) yield* Queue.end(queue)
        return queue
      }),
    }),
  )
  return Token.read("connection add", Option.none()).pipe(
    Effect.provide(
      Layer.mergeAll(
        terminal,
        Stdio.layerTest({ stdinIsTerminal: Effect.succeed(true) }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.map((token) => ({ token, screen: shown.join("") })),
  )
}

it("at a terminal the token is typed at a hidden prompt, which shows the prompt and never what is typed", async () => {
  const { token, screen } = await Effect.runPromise(typed("typed-token", true))
  expect(token).toBe("typed-token")
  expect(screen).toContain(Messages.tokenPrompt())
  for (const part of ["typed-token", "typed", "token\n"]) {
    expect(screen.replace(Messages.tokenPrompt(), "")).not.toContain(part)
  }
})

it("a hidden prompt that is ended with Ctrl-C ends the command with exit 130", async () => {
  const failure = await Effect.runPromise(
    Effect.flip(typed("half-a-tok", false)),
  )
  expect(failure).toMatchObject({ code: 130 })
})
