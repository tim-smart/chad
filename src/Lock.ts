import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { Duration } from "effect"

/**
 * The daemon lock, which answers for both sides whether a daemon runs on a volume. It is a SQLite write transaction
 * held open on an otherwise empty database file, so the operating system drops it when the holder dies.
 */

/** The handles of the locks this process holds. The reference is what keeps a lock: a collected handle is a closed one. */
const held = new Set<DatabaseSync>()

/**
 * Takes the lock as `chad serve` does, and gives a function that lets it go. It gives nothing when another process
 * holds the lock for longer than `busy`. No journal file is ever written next to the lock file.
 */
export const take = (
  path: string,
  busy: Duration.Duration,
): (() => void) | undefined => {
  const lock = new DatabaseSync(path, { timeout: Duration.toMillis(busy) })
  try {
    lock.exec(
      "PRAGMA journal_mode=MEMORY; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;",
    )
  } catch {
    lock.close()
    return undefined
  }
  held.add(lock)
  return () => {
    held.delete(lock)
    lock.close()
  }
}

/**
 * The CLI's test of the same lock. It tries to begin a write transaction with no timeout and rolls it back, and it
 * never creates the lock file. A free lock means no daemon.
 */
export const test = (path: string): "free" | "held" => {
  if (!existsSync(path)) return "free"
  const lock = new DatabaseSync(path, { timeout: 0 })
  try {
    lock.exec("PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE; ROLLBACK;")
    return "free"
  } catch {
    return "held"
  } finally {
    lock.close()
  }
}
