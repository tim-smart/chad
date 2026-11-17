import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// No test in this repo is skipped, todo or only. vitest reports none of those as a failure, so they are found in the
// source. One is written as a modifier, such as `it.skip(...)` or `it.skipIf(...)`, or as a key of the options a test or
// a suite takes, such as `it("...", { skip: true }, ...)`. A key is a name before a colon, quoted or not, or a bare name
// that stands as a shorthand property.
const patterns = [
  /\.(skip|todo|only|skipIf|runIf)\s*[(.`]/,
  /(?:^|[{,])\s*["'](skip|todo|only)["']\s*:/,
  /(?:^|[{,])\s*(skip|todo|only)\s*(?:[:,}]|$)/,
]

export interface Skip {
  /** The line, counted from 1. */
  readonly line: number
  /** The modifier or the key the line uses. */
  readonly uses: string
}

/** Each line of a test file's source that skips a test, marks it todo or runs it alone. */
export const skipsIn = (source: string): ReadonlyArray<Skip> =>
  source.split("\n").flatMap((text, index) => {
    const match = patterns
      .map((pattern) => pattern.exec(text))
      .find((found) => found !== null)
    return match ? [{ line: index + 1, uses: match[1]! }] : []
  })

/**
 * The scan of every test file, run by vitest as a global setup before any test. A global setup is no test, so no
 * modifier can turn the scan off, and it scans its own tests in `test/unit/skips.test.ts` as well.
 */
export default () => {
  const root = fileURLToPath(new URL("../..", import.meta.url))
  const found = globSync("test/**/*.test.ts", { cwd: root }).flatMap((file) =>
    skipsIn(readFileSync(root + file, "utf8")).map(
      (skip) => `${file}:${skip.line} uses ${skip.uses}`,
    ),
  )
  if (found.length > 0)
    throw new Error(
      `No test is skipped, todo or only:\n${found.map((line) => `  ${line}`).join("\n")}`,
    )
}
