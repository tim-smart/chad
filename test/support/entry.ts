// The test entry file. Like `chad serve` it is a few lines that call `runDaemon`, from the built package. It hands
// over the test's outside world and the spec's durations, every length multiplied by one factor.
import { type DaemonInputs, runDaemon } from "../../dist/daemon/runDaemon.js"
import { defaults, scale } from "../../dist/Timings.js"

/** The one scale factor. The 60 seconds of a stop become 3, and the orderings between the lengths hold. */
export const factor = 0.05

export const start = (world: Omit<DaemonInputs, "timings">) =>
  runDaemon({ ...world, timings: scale(defaults, factor) })
