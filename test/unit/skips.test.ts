import { globSync } from "node:fs"
import { expect, it } from "vitest"
import { read, root } from "../support/repo.ts"
import { skipsIn } from "../support/skips.ts"

it("finds no test file that skips a test, marks it todo or runs it alone", () => {
  const found = globSync("test/**/*.test.ts", { cwd: root }).flatMap((file) =>
    skipsIn(read(file)).map((skip) => `${file}:${skip.line} uses ${skip.uses}`),
  )
  expect(found).toEqual([])
})
