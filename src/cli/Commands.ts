import { health } from "./commands/health.ts"
import { status } from "./commands/status.ts"

/**
 * The client commands, which is every command but `serve`. A command is declared in its own file under
 * `commands/` and listed here, and a command that is not listed is an unknown command.
 */
export const commands = [health, status] as const
