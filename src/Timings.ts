import { Context, Duration } from "effect"

/**
 * Every duration chad sets, each with its default. Nothing in the shipped daemon changes one. A test passes its own set
 * to `runDaemon`.
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
  /**
   * The Prettier format of `work/plugins/` that a check and an apply run first, from the start of its process to its
   * end, after which the process is killed and the plugins are left as they are.
   */
  readonly prettierFormat: Duration.Duration
  /**
   * One install of the packages of a lockfile, `npm ci` from start to end. A boot waits for it before it loads the
   * repo's plugins, and an apply before its type-check.
   */
  readonly packageInstall: Duration.Duration
  /** How long npm has to end after a SIGTERM, at an install's deadline or a stop, before it gets a SIGKILL. npm ignores a SIGTERM while it waits to retry a fetch. */
  readonly packageStop: Duration.Duration
  /** Stop, wait for requests in flight, which is cluster's `entityTerminationTimeout`. */
  readonly stopRequests: Duration.Duration
  /** Stop, the point from SIGTERM until which queued hooks run. */
  readonly stopHooksUntil: Duration.Duration
  /** Stop, the point from SIGTERM at which the scopes are closed and the exit is forced. */
  readonly stopDeadline: Duration.Duration
  readonly modelLogin: Duration.Duration
  /** Model trial request, deadline with no retry. */
  readonly modelTrial: Duration.Duration
  /** `requestOnce`, how long the tool waits for the owner to submit the value before its request expires. */
  readonly onceWait: Duration.Duration
  /** One half of an MCP server's OAuth sign-in: its requests to the server and its authorization server. */
  readonly mcpLogin: Duration.Duration
  /** Thread title, deadline of the whole job with no retry: the model's token, its layer, its answer and the rename. */
  readonly threadTitle: Duration.Duration
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
  /** Free space check, interval after the check at boot. */
  readonly freeSpaceInterval: Duration.Duration
  /**
   * Prune, its schedule in the owner's timezone as a cron expression, which is 04:00 every day. It is not a length, so
   * no scale factor changes it, and a scenario that runs the prune on its schedule gives one of its own.
   */
  readonly pruneAt: string
  /** Prune, age of a reset session's history. */
  readonly pruneAge: Duration.Duration
  /** Notice, time after a key's last notice in which the key is not announced again. */
  readonly noticeQuiet: Duration.Duration
  /** Status, the "Recent" block's window for failed turns. */
  readonly statusFailedWindow: Duration.Duration
  /** Status, the "Recent" block's longer window for tokens. */
  readonly statusTokenWindow: Duration.Duration
  /**
   * clanka's `Agent.TurnTimeout`, a duration of the second table that chad does not set: it is unset, so clanka keeps
   * its default, and no scale factor changes it. A test of the silence bound gives it a length of its own,
   * because three of them at the real length are 15 minutes.
   */
  readonly turnTimeout: Duration.Duration | undefined
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
  prettierFormat: Duration.minutes(2),
  packageInstall: Duration.minutes(5),
  packageStop: Duration.seconds(5),
  stopRequests: Duration.seconds(15),
  stopHooksUntil: Duration.seconds(50),
  stopDeadline: Duration.seconds(60),
  modelLogin: Duration.minutes(15),
  modelTrial: Duration.seconds(60),
  onceWait: Duration.minutes(5),
  mcpLogin: Duration.seconds(60),
  threadTitle: Duration.seconds(30),
  sessionIdle: Duration.minutes(30),
  messagePoll: Duration.seconds(1),
  messageRetention: Duration.days(1),
  catchUpWindow: Duration.days(7),
  statusEditInterval: Duration.seconds(2),
  healthPing: Duration.seconds(2),
  cliAnswer: Duration.seconds(2),
  lockBusy: Duration.seconds(3),
  freeSpaceInterval: Duration.hours(1),
  pruneAt: "0 4 * * *",
  pruneAge: Duration.days(30),
  noticeQuiet: Duration.hours(24),
  statusFailedWindow: Duration.hours(24),
  statusTokenWindow: Duration.days(7),
  turnTimeout: undefined,
}

/**
 * Every length multiplied by one factor, so the orderings between them hold. The prune's time of day is left alone, and
 * so is clanka's turn timeout, which is not chad's.
 */
export const scale = (timings: Timings, factor: number): Timings => {
  const { pruneAt, turnTimeout, ...lengths } = timings
  const scaled = Object.fromEntries(
    Object.entries(lengths).map(([name, length]) => [
      name,
      Duration.times(length, factor),
    ]),
  ) as Omit<Timings, "pruneAt" | "turnTimeout">
  return { ...scaled, pruneAt, turnTimeout }
}

/** The durations the daemon runs on. `runDaemon` sets it from its input. */
export const Timings = Context.Reference<Timings>("chad/Timings", {
  defaultValue: () => defaults,
})
