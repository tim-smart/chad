import { readdirSync } from "node:fs"
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
import { read } from "../support/repo.ts"

it("CLI-217 CLI-218 CLI-219 CLI-220 CLI-221 CLI-222 CLI-223 CLI-224 CLI-225 CLI-226 CLI-227 CLI-233 STO-197 the lines of the connection and owner commands are templates of the Messages module, in the spec's wording", () => {
  const spec = read("docs/spec/10-cli.md") + read("docs/spec/02-storage.md")
  const rejected = (
    reason: Parameters<typeof Messages.connectionRejected>[1]["reason"],
    detail = "",
  ) =>
    Messages.connectionRejected("<command>", { reason, name: "<name>", detail })
  const templates = [
    Messages.ownerRefused("<command>", "<session>"),
    Messages.daemonGone("<command>"),
    Messages.volumeMissing("<command>", "<data>"),
    Messages.cliOlder("<command>", "<cli>", "<volume>"),
    Messages.daemonStarted("<command>"),
    Messages.unreadable("<command>", "<path>", "<error code>"),
    Messages.malformed("<command>", "<path>"),
    Messages.newerFormat("<command>", "<path>", "<found>", 1).replace(
      "format 1.",
      "format <known>.",
    ),
    Messages.noToken("<command>"),
    Messages.tokenPrompt(),
    rejected("name-invalid"),
    rejected("name-taken"),
    rejected("second-local"),
    rejected("no-connection"),
    rejected("no-token"),
    rejected("last-connection"),
    rejected("last-owner", "<id>"),
    rejected("token-refused", "<status>"),
    rejected("token-unchecked", "<detail>"),
    Messages.connectionAdded("<name>", "<kind>"),
    Messages.connectionInvite("<url>"),
    Messages.connectionIntents(["<names>"]),
    Messages.connectionToken("<name>"),
    Messages.connectionRemoved("<name>"),
    Messages.ownerAdded("<id>", "<connection>"),
    Messages.ownerRemoved("<id>", "<connection>"),
    Messages.ownerListed("<id>", "<connection>"),
    Messages.ownerUnlisted("<id>", "<connection>"),
    Messages.connectionLine("<name>", "<kind>", ["<ids>"]),
    Messages.noConnections(),
    Messages.connectionChecked("<name>", "<kind>", "ok", ""),
    Messages.connectionChecked("<name>", "<kind>", "token-refused", "<status>"),
    Messages.connectionChecked(
      "<name>",
      "<kind>",
      "token-unchecked",
      "<detail>",
    ),
    Messages.connectionChecked(
      "<name>",
      "<kind>",
      "no-platform",
      "<socket>: <error code>",
    ),
  ]
  for (const template of templates) expect(spec).toContain(template)
  // The reasons about the file render as the file's own lines, and the daemon's refusal is the same line.
  expect(
    Messages.connectionRejected("<command>", {
      reason: "newer-format",
      name: "<path>",
      detail: "<found>",
    }),
  ).toBe(Messages.newerFormat("<command>", "<path>", "<found>", 1))
  expect(rejected("unreadable", "<error code>")).toBe(
    Messages.unreadable("<command>", "<name>", "<error code>"),
  )
  expect(rejected("malformed")).toBe(Messages.malformed("<command>", "<name>"))
  expect(
    Messages.connectionsRefused({
      reason: "malformed",
      name: "<path>",
      detail: "",
    }),
  ).toBe(Messages.malformed("serve", "<path>"))
  expect(Messages.connectionLine("<name>", "<kind>", [])).toBe(
    "<name> (<kind>) owners: none",
  )
  expect(Messages.connectionLine("<name>", "<kind>", ["a", "b"])).toBe(
    "<name> (<kind>) owners: a, b",
  )
})

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

it("CLI-186 at a terminal the token is typed at a hidden prompt, which shows the prompt and never what is typed", async () => {
  const { token, screen } = await Effect.runPromise(typed("typed-token", true))
  expect(token).toBe("typed-token")
  expect(screen).toContain(Messages.tokenPrompt())
  for (const part of ["typed-token", "typed", "token\n"]) {
    expect(screen.replace(Messages.tokenPrompt(), "")).not.toContain(part)
  }
})

it("CLI-223 a hidden prompt that is ended with Ctrl-C ends the command with exit 130", async () => {
  const failure = await Effect.runPromise(
    Effect.flip(typed("half-a-tok", false)),
  )
  expect(failure).toMatchObject({ code: 130 })
})

it("TST-84 a scenario names a message through the Messages module: no scenario file quotes the fixed words of a template", () => {
  // The fixed words of every template, which are what stands between its placeholders.
  const code = read("src/Messages.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
  const fragments = [...code.matchAll(/`([^`]*)`|"([^"\n]*)"/g)]
    .flatMap((match) => (match[1] ?? match[2] ?? "").split(/\$\{[^}]*\}/))
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.split(/\s+/).length >= 4)
  expect(fragments.length).toBeGreaterThan(40)
  const scenarios = readdirSync("test/daemon").filter((file) =>
    file.endsWith(".test.ts"),
  )
  expect(scenarios).toContain("connections.test.ts")
  for (const file of scenarios) {
    const source = read("test/daemon/" + file)
    for (const fragment of fragments) {
      expect(source.includes(fragment), `${file} quotes "${fragment}"`).toBe(
        false,
      )
    }
  }
})
