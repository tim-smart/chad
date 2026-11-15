import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

/**
 * The database as `chad db` reads it: a connection of the CLI's own, read-only, opened for one statement and closed
 * after it. It never goes through the daemon, and SQLite refuses it a write.
 */

/** A value as SQLite gives it. An integer is a bigint, because some of the ids in the database are wider than a number. */
export type Value = null | number | bigint | string | Uint8Array

export interface Rows {
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReadonlyArray<Value>>
  /** Whether the statement had more rows than the limit let through. */
  readonly more: boolean
}

/** There is no database file at the path. */
export class Missing extends Error {
  readonly path: string
  constructor(path: string) {
    super(path)
    this.path = path
  }
}

/**
 * Runs one statement and gives at most `limit` of its rows. It throws `Missing` when there is no database, and
 * SQLite's own error for a statement that fails, which a statement that writes does.
 */
export const query = (path: string, sql: string, limit: number): Rows => {
  // A read-only open of a missing file fails without naming the file.
  if (!existsSync(path)) throw new Missing(path)
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const statement = database.prepare(sql)
    statement.setReadBigInts(true)
    statement.setReturnArrays(true)
    const columns = statement.columns().map((column) => column.name)
    const rows: Array<ReadonlyArray<Value>> = []
    let more = false
    for (const row of statement.iterate()) {
      if (rows.length === limit) {
        more = true
        break
      }
      rows.push(row as unknown as ReadonlyArray<Value>)
    }
    return { columns, rows, more }
  } finally {
    database.close()
  }
}

const hex = (bytes: Uint8Array) => `x'${Buffer.from(bytes).toString("hex")}'`

const escapes: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "\t": "\\t",
  "\n": "\\n",
}

/** A backslash, a tab and a newline are escaped, so that a value never breaks its row. */
const escape = (text: string) =>
  text.replace(/[\\\t\n]/g, (character) => escapes[character] ?? character)

const cell = (value: Value): string =>
  value === null
    ? "NULL"
    : value instanceof Uint8Array
      ? hex(value)
      : escape(String(value))

/** The rows as text: a header line, then one line for each row, with the values separated by tabs. */
export const text = ({ columns, rows }: Rows): string =>
  [columns.map(escape), ...rows.map((row) => row.map(cell))]
    .map((line) => line.join("\t"))
    .join("\n")

const plain = (value: Value): string | number | null =>
  typeof value === "bigint"
    ? Number.isSafeInteger(Number(value))
      ? Number(value)
      : String(value)
    : value instanceof Uint8Array
      ? hex(value)
      : value

/** The rows as JSON on one line: an array with one object for each row, keyed by column name. */
export const json = ({ columns, rows }: Rows): string =>
  JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(
        columns.map((column, index) => [column, plain(row[index] ?? null)]),
      ),
    ),
  )
