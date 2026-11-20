import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import * as Messages from "../../Messages.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Owner from "../Owner.ts"
import * as Repository from "../Repository.ts"
import * as Token from "../Token.ts"

/**
 * `chad mcp restart`: rebuilds the MCP layer, which restarts every server. It needs the daemon and takes its place in
 * the daemon's queue.
 */
const restart = Command.make(
  "restart",
  {},
  Effect.fn("mcp.restart")(function* () {
    return yield* Repository.through("mcp restart", { _tag: "McpRestart" })
  }),
).pipe(Command.withDescription("Restart every MCP server"))

const server = Argument.String("server").pipe(
  Argument.withDescription("The server's name in mcp.json"),
)

/**
 * `chad mcp login <server>`: the owner's OAuth sign-in to an HTTP server with an `oauth` key. The daemon gives the
 * link, the owner approves in a browser, and the address the browser ended on is read from a prompt that echoes
 * nothing, or from stdin when it is not a terminal, and never from an argument, since it carries the sign-in's code.
 * A sign-in that finished rebuilds the MCP layer.
 */
const login = Command.make(
  "login",
  { server },
  Effect.fn("mcp.login")(function* ({ server }) {
    const command = "mcp login"
    yield* Owner.only(command)
    yield* Repository.through(command, { _tag: "McpLoginStart", server })
    const address = (yield* Token.entered(Messages.mcpLoginPrompt)).trim()
    if (address === "")
      return yield* new Failure({
        code: ExitCode.usage,
        message: Messages.mcpLoginNoAddress(),
      })
    return yield* Repository.through(command, {
      _tag: "McpLoginFinish",
      server,
      address,
    })
  }),
).pipe(Command.withDescription("Sign in to an MCP server with OAuth"))

/**
 * `chad mcp logout <server>`: drops the server's tokens and the client chad registered for it, and rebuilds the MCP
 * layer, which leaves the server needing a login.
 */
const logout = Command.make(
  "logout",
  { server },
  Effect.fn("mcp.logout")(function* ({ server }) {
    yield* Owner.only("mcp logout")
    return yield* Repository.through("mcp logout", {
      _tag: "McpLogout",
      server,
    })
  }),
).pipe(Command.withDescription("Sign out of an MCP server"))

/** `chad mcp`: the MCP servers that `mcp.json` lists. */
export const mcp = Command.make("mcp").pipe(
  Command.withDescription("Manage the MCP servers"),
  Command.withSubcommands([restart, login, logout]),
)
