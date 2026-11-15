// Reads a scenario's database from outside the daemon, as `chad db query` will once the `cli` slice delivers it.
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * Runs one statement that writes, for a scenario that breaks the database on purpose. It waits for a daemon that is
 * running to let go of the write lock.
 */
export const execute = (data: string, sql: string): void => {
  const database = new DatabaseSync(join(data, "db/chad.db"), {
    timeout: 5_000,
  })
  try {
    database.exec(sql)
  } finally {
    database.close()
  }
}

/** Runs one read-only query on the database of a volume. Integers come back as bigint, because cluster's ids are wide. */
export const query = (
  data: string,
  sql: string,
): ReadonlyArray<Record<string, unknown>> => {
  const database = new DatabaseSync(join(data, "db/chad.db"), {
    readOnly: true,
  })
  try {
    const statement = database.prepare(sql)
    statement.setReadBigInts(true)
    return statement.all().map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}
