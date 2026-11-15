import type { LogLevel } from "effect"

/**
 * The event names chad writes to its log, each with its level. The list is closed: a name is added here only together
 * with its row in the event table of docs/spec/16-failures-logs-status.md.
 *
 * Two names take more than one level. `message.ignored` is at Info for the reason `not-owner` and at Debug for every
 * other reason, and `plugin.log` takes the level of the plugin's own line.
 */
export const events = {
  "turn.started": "Info",
  "turn.script-started": "Info",
  "turn.script-ended": "Info",
  "turn.subagent-started": "Info",
  "turn.subagent-ended": "Info",
  "turn.compaction": "Info",
  "turn.retry": "Warn",
  "turn.login-wait": "Info",
  "turn.steered": "Info",
  "turn.resumed": "Info",
  "turn.ended": "Info",
  "turn.failed": "Error",
  "turn.answer-unposted": "Error",
  "history.reconciled": "Info",
  "model.check-failed": "Warn",
  "model.logged-in": "Info",
  "hook.failed": "Warn",
  "hook.failing": "Warn",
  "hook.dropped": "Warn",
  "swap.overrun": "Warn",
  "swap.overrun-ended": "Info",
  "swap.close-abandoned": "Warn",
  "apply.done": "Info",
  "apply.failed": "Error",
  "plugin.skipped": "Warn",
  "plugin.log": "Info",
  "settings.unparsable": "Warn",
  "settings.ignored": "Warn",
  "mcp.config-unreadable": "Warn",
  "mcp.needs-login": "Warn",
  "mcp.login-expired": "Info",
  "mcp.server-failed": "Warn",
  "mcp.rebuilt": "Info",
  "skill.skipped": "Warn",
  "skill.bundled-changed": "Info",
  "disk.low": "Warn",
  "disk.full": "Error",
  "database.unusable": "Error",
  "database.migrated": "Info",
  "prune.failed": "Error",
  "backup.failed": "Error",
  "boot.started": "Info",
  "boot.ready": "Info",
  "boot.setup-needed": "Warn",
  "boot.moved-aside": "Warn",
  "boot.filesystem": "Warn",
  "boot.log-level-unknown": "Warn",
  "boot.safe-mode-auto": "Error",
  "boot.refused": "Fatal",
  "stop.started": "Info",
  "stop.ended": "Info",
  "stop.dropped": "Warn",
  "stop.cut": "Error",
  "chat.connected": "Info",
  "chat.disconnected": "Warn",
  "chat.refused": "Error",
  "message.ignored": "Info",
  "command.ran": "Info",
  "timer.held": "Warn",
  "rpc.cancelled": "Debug",
  "notice.sent": "Info",
  "notice.undelivered": "Warn",
} as const satisfies Record<`${string}.${string}`, LogLevel.Severity>

export type EventName = keyof typeof events

/** The level of an event's line. `reason` is the reason of a `message.ignored` line. */
export const levelOf = (
  event: EventName,
  reason?: string,
): LogLevel.Severity =>
  event === "message.ignored" && reason !== "not-owner"
    ? "Debug"
    : events[event]
