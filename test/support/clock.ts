// A clock a scenario moves forward, for a plugin's Layer. Its time is the real time plus what the scenario has
// advanced, and a sleep on it ends when either reaches its deadline.
import { Clock, Duration, Effect } from "effect"

export interface Adjustable extends Clock.Clock {
  /** Moves the clock forward, and ends every sleep whose deadline that passes. */
  readonly advance: (duration: Duration.Input) => void
}

/** The longest delay `setTimeout` takes. A longer sleep ends only when the clock is advanced past it. */
const MAX_TIMER_MILLIS = 2 ** 31 - 1

export const make = (): Adjustable => {
  let offset = 0
  const sleepers = new Set<{ readonly at: number; readonly wake: () => void }>()
  const now = () => Date.now() + offset
  const nanos = () => BigInt(now()) * 1_000_000n
  const monotonic = () => process.hrtime.bigint() + BigInt(offset) * 1_000_000n
  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: monotonic,
    monotonicTimeNanos: Effect.sync(monotonic),
    sleep: (duration) => {
      const millis = Duration.toMillis(duration)
      if (millis <= 0) return Effect.yieldNow
      return Effect.callback<void>((resume) => {
        const sleeper = {
          at: now() + millis,
          wake: () => {
            end()
            resume(Effect.void)
          },
        }
        const handle =
          millis <= MAX_TIMER_MILLIS
            ? setTimeout(sleeper.wake, millis)
            : undefined
        const end = () => {
          clearTimeout(handle)
          sleepers.delete(sleeper)
        }
        sleepers.add(sleeper)
        return Effect.sync(end)
      })
    },
    advance: (duration) => {
      offset += Duration.toMillis(duration)
      for (const sleeper of sleepers) if (sleeper.at <= now()) sleeper.wake()
    },
  }
}
