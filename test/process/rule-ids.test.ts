import { spawnSync } from "node:child_process"
import { beforeAll, describe, expect, it } from "vitest"
import type { IndexEntry } from "../../scripts/rule-ids.ts"
import { gateRuns, json, path, read, yaml } from "../support/repo.ts"

// The comparison is run as CI runs it, with no CI variable in its environment.
describe("the rule-id script, run over this repository", () => {
  const { CI: _, ...env } = process.env
  const script = (...args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, [path("scripts/rule-ids.ts"), ...args], {
      env,
      encoding: "utf8",
    })
  let comparison: ReturnType<typeof script>
  let index: ReadonlyArray<IndexEntry>
  beforeAll(() => {
    comparison = script()
    index = json(".rule-ids/index.json")
  }, 60_000)
  const testsOf = (id: string) =>
    index
      .find((entry) => entry.id === id)
      ?.units.flatMap((unit) => unit.tests.map((test) => test.name))

  it("TST-170 reads the spec's rule ids from docs/spec/ in the repository", () => {
    const rows = read("docs/spec/17-testing.md").match(/^\| TST-\d+ \|/gm) ?? []
    expect(rows.length).toBeGreaterThan(200)
    expect(
      index.filter((entry) => entry.part === "17-testing.md"),
    ).toHaveLength(rows.length)
  })

  it("TST-12 writes an index from each rule to its tests, which CI keeps as an artifact", () => {
    expect(testsOf("TST-12")).toEqual([
      "the rule-id script, run over this repository > TST-12 writes an index from each rule to its tests, which CI keeps as an artifact",
    ])
    const steps: ReadonlyArray<{ uses?: string; with?: { path: string } }> =
      yaml(".github/workflows/gate.yml").jobs["rule-ids"].steps
    const upload = steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    )
    expect(upload?.with?.path).toBe(".rule-ids/index.json")
    expect(read(".gitignore").split("\n")).toContain(".rule-ids")
  })

  it("TST-15 the comparison gates in CI alone, and the script runs outside CI all the same", () => {
    expect(comparison.stdout).toMatch(/^rules: \d+, tested: \d+$/m)
    expect(script("show", "TST-15").stdout).toContain(
      "- **TST-15** Neither local command",
    )
    expect(gateRuns()["rule-ids"]).toContain("pnpm rule-ids")
    expect(json("package.json").scripts["rule-ids"]).toBe(
      "node scripts/rule-ids.ts",
    )
    expect(read("scripts/local.ts")).not.toContain("rule-ids")
  })
})
