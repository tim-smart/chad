import { apply } from "./commands/apply.ts"
import { backup, restore } from "./commands/backup.ts"
import { check } from "./commands/check.ts"
import { connection } from "./commands/connection.ts"
import { db } from "./commands/db.ts"
import { health } from "./commands/health.ts"
import { login } from "./commands/login.ts"
import { logout } from "./commands/logout.ts"
import { log } from "./commands/log.ts"
import { logs } from "./commands/logs.ts"
import { mcp } from "./commands/mcp.ts"
import { model } from "./commands/model.ts"
import { owner } from "./commands/owner.ts"
import { plugin } from "./commands/plugin.ts"
import { revert } from "./commands/revert.ts"
import { safe } from "./commands/safe.ts"
import { secret } from "./commands/secret.ts"
import { setup } from "./commands/setup.ts"
import { skill } from "./commands/skill.ts"
import { status } from "./commands/status.ts"
import { timezone } from "./commands/timezone.ts"

/**
 * The client commands, which is every command but `serve`. A command is declared in its own file under
 * `commands/` and listed here, and a command that is not listed is an unknown command.
 */
export const commands = [
  health,
  status,
  connection,
  owner,
  setup,
  login,
  logout,
  model,
  db,
  logs,
  check,
  apply,
  revert,
  log,
  safe,
  plugin,
  skill,
  mcp,
  timezone,
  secret,
  backup,
  restore,
] as const
