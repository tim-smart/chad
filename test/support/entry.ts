// The test entry file. Like `chad serve` it is a few lines that call `runDaemon`, from the built package. It hands
// over the test's outside world and the spec's durations, every length multiplied by one factor.
import { type DaemonInputs, runDaemon } from "../../dist/daemon/runDaemon.js"
import { defaults, scale, type Timings } from "../../dist/Timings.js"
import { factor } from "./factor.ts"

/**
 * The lengths a scenario may set by itself, apart from the factor (docs/spec/17-testing.md, TST-212, TST-214). Each is
 * still too long for a test once it is scaled, and no ordering with another length rests on it (TST-215). The prune's
 * schedule is no length, and a scenario that runs the prune gives one of its own.
 */
type Lengths = "sessionIdle" | "messageRetention" | "modelLogin" | "turnTimeout"
export type Own = Partial<Pick<Timings, Lengths | "pruneAt">>

export const start = (world: Omit<DaemonInputs, "timings">, own: Own = {}) =>
  runDaemon({ ...world, timings: { ...scale(defaults, factor), ...own } })
