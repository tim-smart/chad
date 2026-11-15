import { Context, Duration } from "effect"

/**
 * Every duration chad sets, one value for each row of the durations table in docs/spec/17-testing.md. The defaults are
 * the spec's values, and nothing in the shipped daemon changes one. A test passes its own set to `runDaemon`.
 */
export interface Timings {
  /** Plugin swap, drain of calls and hooks in flight. */
  readonly swapDrain: Duration.Duration
  /** Plugin swap, wait for an interrupted call or hook to stop. */
  readonly swapInterruptWait: Duration.Duration
  /** Plugin swap, close of the old versions' scopes. */
  readonly swapClose: Duration.Duration
  readonly hookPromptChunk: Duration.Duration
  readonly hookBeforeTurn: Duration.Duration
  readonly hookAfterTurn: Duration.Duration
  readonly hookOnSession: Duration.Duration
  /** One plugin's Layer build. */
  readonly pluginBuild: Duration.Duration
  /** Stop, wait for requests in flight, which is cluster's `entityTerminationTimeout`. */
  readonly stopRequests: Duration.Duration
  /** Stop, the point from SIGTERM until which queued hooks run. */
  readonly stopHooksUntil: Duration.Duration
  /** Stop, the point from SIGTERM at which the scopes are closed and the exit is forced. */
  readonly stopDeadline: Duration.Duration
  /** MCP rebuild, drain of calls in flight. */
  readonly mcpDrain: Duration.Duration
  /** MCP rebuild, wait for each interrupted call to stop. */
  readonly mcpInterruptWait: Duration.Duration
  /** MCP rebuild, pause between interrupting calls and closing the old layer. */
  readonly mcpClosePause: Duration.Duration
  /** MCP call held during a rebuild or before the first layer connects. */
  readonly mcpCallBackstop: Duration.Duration
  readonly modelLogin: Duration.Duration
  /** Model trial request, deadline with no retry. */
  readonly modelTrial: Duration.Duration
  /** MCP login, life of a pending login. */
  readonly mcpLogin: Duration.Duration
  /** `chad secret request` wait. */
  readonly secretRequest: Duration.Duration
  /** TOTP, time left in the window under which `code` and `run` wait for the next one. */
  readonly totpWait: Duration.Duration
  /** Session passivation after idle. */
  readonly sessionIdle: Duration.Duration
  /** Cluster's `entityMessagePollInterval`. */
  readonly messagePoll: Duration.Duration
  /** `MessageRetention` for the `Session` entity. */
  readonly messageRetention: Duration.Duration
  /** Catch-up after a fresh identify, how far back a session counts as active. */
  readonly catchUpWindow: Duration.Duration
  /** Status message, least time between two edits. */
  readonly statusEditInterval: Duration.Duration
  /** `chad health`, time the daemon has to answer the ping. */
  readonly healthPing: Duration.Duration
  /** CLI, time the daemon has to answer before the CLI says "starting or frozen". */
  readonly cliAnswer: Duration.Duration
  /** Daemon lock, busy timeout. */
  readonly lockBusy: Duration.Duration
  /** Boot counter, time after the boot finished loading at which it clears. */
  readonly bootCountClear: Duration.Duration
  /** Free space check, interval after the check at boot. */
  readonly freeSpaceInterval: Duration.Duration
  /** Prune, time of day in the owner's timezone. It is not a length, so no scale factor changes it. */
  readonly pruneAt: { readonly hour: number; readonly minute: number }
  /** Prune, age of a reset session's history. */
  readonly pruneAge: Duration.Duration
  /** Turn end that could not be written on a full disk, interval between tries. */
  readonly turnEndRetry: Duration.Duration
  /** Notice, time after a key's last notice in which the key is not announced again. */
  readonly noticeQuiet: Duration.Duration
  /** Status, the "Recent" block's window for failed turns. */
  readonly statusFailedWindow: Duration.Duration
  /** Status, the "Recent" block's longer window for tokens. */
  readonly statusTokenWindow: Duration.Duration
}

export const defaults: Timings = {
  swapDrain: Duration.seconds(30),
  swapInterruptWait: Duration.seconds(1),
  swapClose: Duration.seconds(10),
  hookPromptChunk: Duration.seconds(2),
  hookBeforeTurn: Duration.seconds(5),
  hookAfterTurn: Duration.seconds(30),
  hookOnSession: Duration.seconds(10),
  pluginBuild: Duration.seconds(30),
  stopRequests: Duration.seconds(15),
  stopHooksUntil: Duration.seconds(50),
  stopDeadline: Duration.seconds(60),
  mcpDrain: Duration.seconds(30),
  mcpInterruptWait: Duration.seconds(1),
  mcpClosePause: Duration.millis(250),
  mcpCallBackstop: Duration.seconds(120),
  modelLogin: Duration.minutes(15),
  modelTrial: Duration.seconds(60),
  mcpLogin: Duration.minutes(10),
  secretRequest: Duration.minutes(5),
  totpWait: Duration.seconds(5),
  sessionIdle: Duration.minutes(30),
  messagePoll: Duration.seconds(1),
  messageRetention: Duration.days(1),
  catchUpWindow: Duration.days(7),
  statusEditInterval: Duration.seconds(2),
  healthPing: Duration.seconds(2),
  cliAnswer: Duration.seconds(2),
  lockBusy: Duration.seconds(3),
  bootCountClear: Duration.seconds(60),
  freeSpaceInterval: Duration.hours(1),
  pruneAt: { hour: 4, minute: 0 },
  pruneAge: Duration.days(30),
  turnEndRetry: Duration.seconds(60),
  noticeQuiet: Duration.hours(24),
  statusFailedWindow: Duration.hours(24),
  statusTokenWindow: Duration.days(7),
}

/** Every length multiplied by one factor, so the orderings between them hold. The prune's time of day is left alone. */
export const scale = (timings: Timings, factor: number): Timings => {
  const { pruneAt, ...lengths } = timings
  const scaled = Object.fromEntries(
    Object.entries(lengths).map(([name, length]) => [
      name,
      Duration.times(length, factor),
    ]),
  ) as Omit<Timings, "pruneAt">
  return { ...scaled, pruneAt }
}

/** The durations the daemon runs on. `runDaemon` sets it from its input. */
export const Timings = Context.Reference<Timings>("chad/Timings", {
  defaultValue: () => defaults,
})
