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
