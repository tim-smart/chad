import { spawnSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { IndexEntry } from "../../scripts/rule-ids.ts"
import { gateRuns, json, path, read, yaml } from "../support/repo.ts"

// The script is run as a developer runs it, with no CI variable in its environment.
const { CI: _, ...env } = process.env
const script = (file: string, ...args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8" })

// A checkout of one rule, one slice and one test. The comparison over this repository needs every project, so it
// runs in CI alone (TST-15), and what the script does with a checkout is tested on this one.
const files: Record<string, string> = {
  "docs/spec/01-a-part.md": [
    "## A section",
    "",
    "- **AA-1** A statement.",
    "",
    "## Provenance",
    "",
    "| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| AA-1 | TIM-1 | Tim | not run | TIM-3 | `rule` | `early` |",
  ].join("\n"),
  "docs/spec/19-build-order.md": [
    "## Slices",
    "",
    "| Slice | Stage | What it delivers |",
    "| --- | --- | --- |",
    "| `early` | 1 | The first things. |",
  ].join("\n"),
  "docs/spec/delivered.md": "## Slices\n\n- `early`\n",
  "vitest.config.ts": [
    'import { defineConfig } from "vitest/config"',
    "export default defineConfig({",
    '  test: { projects: [{ test: { name: "unit", include: ["test/unit/**/*.test.ts"] } }] },',
    "})",
  ].join("\n"),
  "test/unit/a.test.ts": [
    'import { it } from "vitest"',
    'it("AA-1 holds", () => {})',
  ].join("\n"),
}

describe("the rule-id script, run over a checkout", () => {
  let checkout: string
  let comparison: ReturnType<typeof script>
  beforeAll(() => {
    checkout = mkdtempSync(join(tmpdir(), "chad-rule-ids-"))
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(checkout, file)), { recursive: true })
      writeFileSync(join(checkout, file), content)
    }
    cpSync(path("scripts/rule-ids.ts"), join(checkout, "scripts/rule-ids.ts"))
    symlinkSync(path("node_modules"), join(checkout, "node_modules"))
    comparison = script(join(checkout, "scripts/rule-ids.ts"))
  }, 60_000)
  afterAll(() => rmSync(checkout, { recursive: true, force: true }))

  it("TST-170 reads the spec's rule ids from docs/spec/ in the repository", () => {
    expect(comparison.stdout).toMatch(/^rules: 1$/m)
    expect(
      script(path("scripts/rule-ids.ts"), "show", "TST-170").stdout,
    ).toContain("- **TST-170** The spec lives in chad's repository")
  })

  it("TST-12 writes an index from each rule to its tests, which CI keeps as an artifact", () => {
    const index: ReadonlyArray<IndexEntry> = JSON.parse(
      readFileSync(join(checkout, ".rule-ids/index.json"), "utf8"),
    )
    expect(
      index.map((entry) => [entry.id, entry.tests.map((test) => test.name)]),
    ).toEqual([["AA-1", ["AA-1 holds"]]])
    const steps: ReadonlyArray<{
      uses?: string
      with?: Record<string, unknown>
    }> = yaml(".github/workflows/gate.yml").jobs["rule-ids"].steps
    const upload = steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    )
    expect(upload?.with).toMatchObject({
      path: ".rule-ids/index.json",
      "if-no-files-found": "error",
    })
    expect(read(".gitignore").split("\n")).toContain(".rule-ids")
  })

  it("TST-15 the comparison gates in CI alone, and the script runs outside CI all the same", () => {
    expect(comparison.status).toBe(0)
    expect(gateRuns()["rule-ids"]).toContain("pnpm rule-ids")
    expect(json("package.json").scripts["rule-ids"]).toBe(
      "node scripts/rule-ids.ts",
    )
    expect(read("scripts/local.ts")).not.toContain("rule-ids")
  })
})
