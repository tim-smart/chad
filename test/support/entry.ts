// The test entry file. Like `chad serve` it is a few lines that call `runDaemon`, from the built package. It hands
// over the test's outside world and the spec's durations, every length multiplied by one factor.
import { type DaemonInputs, runDaemon } from "../../dist/daemon/runDaemon.js"
import { defaults, scale, type Timings } from "../../dist/Timings.js"

/** The one scale factor. The 60 seconds of a stop become 3, and the orderings between the lengths hold. */
export const factor = 0.05

/**
 * The lengths a scenario may set by itself, apart from the factor (docs/spec/17-testing.md, TST-212). Each is still too
 * long for a test once it is scaled, and no ordering with another length rests on it.
 */
export type Own = Partial<Pick<Timings, "sessionIdle" | "messageRetention">>

export const start = (world: Omit<DaemonInputs, "timings">, own: Own = {}) =>
  runDaemon({ ...world, timings: { ...scale(defaults, factor), ...own } })
