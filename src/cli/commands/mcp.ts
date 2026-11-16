import { Effect } from "effect"
import { Command } from "effect/cli"
import * as Repository from "../Repository.ts"

/**
 * `chad mcp restart`: rebuilds the MCP layer, which restarts every server. It needs the daemon and takes its place in
 * the daemon's queue (CLI-32, CLI-91, CLI-92, MCP-39, MCP-42).
 */
const restart = Command.make(
  "restart",
  {},
  Effect.fn("mcp.restart")(function* () {
    return yield* Repository.through("mcp restart", { _tag: "McpRestart" })
  }),
).pipe(Command.withDescription("Restart every MCP server"))

/** `chad mcp`: the MCP servers that `mcp.json` lists. */
export const mcp = Command.make("mcp").pipe(
  Command.withDescription("Manage the MCP servers"),
  Command.withSubcommands([restart]),
)
