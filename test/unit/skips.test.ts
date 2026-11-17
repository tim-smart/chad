import { globSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { read, root } from "../support/repo.ts"
import { skipsIn } from "../support/skips.ts"

// The modifiers and keys are spliced in, so that this file does not itself hold one.
const call = (test: string, modifier: string) =>
  `${test}.${modifier}("a title", () => {})`
const conditional = (test: string, modifier: string) =>
  `${test}.${modifier}(true)("a title", () => {})`
const option = (test: string, key: string) =>
  `${test}("a title", { ${key}: true }, () => {})`

describe("the check for skipped tests", () => {
  it("finds no test file that skips a test, marks it todo or runs it alone", () => {
    const found = globSync("test/**/*.test.ts", { cwd: root }).flatMap((file) =>
      skipsIn(read(file)).map(
        (skip) => `${file}:${skip.line} uses ${skip.uses}`,
      ),
    )
    expect(found).toEqual([])
  })

  it("finds each modifier, the conditional ones included", () => {
    expect(
      skipsIn(
        [
          call("it", "skip"),
          call("it", "todo"),
          call("describe", "only"),
          conditional("it", "skipIf"),
          conditional("test", "runIf"),
          `it.${"skip"}.each([1])("a title", () => {})`,
          `it.${"only"}\`a title\``,
        ].join("\n"),
      ),
    ).toEqual([
      { line: 1, uses: "skip" },
      { line: 2, uses: "todo" },
      { line: 3, uses: "only" },
      { line: 4, uses: "skipIf" },
      { line: 5, uses: "runIf" },
      { line: 6, uses: "skip" },
      { line: 7, uses: "only" },
    ])
  })

  it("finds each key of a test's or a suite's options, quoted, bare or shorthand", () => {
    expect(
      skipsIn(
        [
          option("it", "skip"),
          option("describe", "todo"),
          option("it", `"${"only"}"`),
          'it("a title", {',
          "  timeout: 1000,",
          `  ${"skip"},`,
          "}, () => {})",
        ].join("\n"),
      ),
    ).toEqual([
      { line: 1, uses: "skip" },
      { line: 2, uses: "todo" },
      { line: 3, uses: "only" },
      { line: 6, uses: "skip" },
    ])
  })

  it("passes a test with other options and code that only shares the words", () => {
    expect(
      skipsIn(
        [
          'it("a title", { timeout: 1000 }, () => {})',
          "const skipped = items.slice(1)",
          "const onlyOnce = { onlyOnce: true, skipCount: 2 }",
          'expect(line).toContain("skip")',
        ].join("\n"),
      ),
    ).toEqual([])
  })
})
