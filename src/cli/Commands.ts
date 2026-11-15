import { connection } from "./commands/connection.ts"
import { db } from "./commands/db.ts"
import { health } from "./commands/health.ts"
import { logs } from "./commands/logs.ts"
import { owner } from "./commands/owner.ts"
import { status } from "./commands/status.ts"

/**
 * The client commands, which is every command but `serve`. A command is declared in its own file under
 * `commands/` and listed here, and a command that is not listed is an unknown command.
 */
export const commands = [health, status, connection, owner, db, logs] as const
