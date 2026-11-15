import { describe, expect, it } from "vitest"
import {
  command,
  evaluate,
  list,
  parseSpec,
  show,
  summary,
  type ListedTest,
} from "../../scripts/rule-ids.ts"

// A spec of two parts and a build order of two slices, `early` and `late`.
interface FixtureRule {
  readonly id: string
  readonly slice: string
  readonly text?: string
  readonly kind?: string
  readonly agreedBy?: string
}

const buildOrder = [
  "## Slices",
  "",
  "| Slice | Stage | What it delivers |",
  "| --- | --- | --- |",
  "| `early` | 1 | The first things. |",
  "| `late` | 2 | The rest. |",
].join("\n")

const part = (rules: ReadonlyArray<FixtureRule>) =>
  [
    "# A part",
    "",
    "## A section",
    "",
    ...rules.map((rule) => `- **${rule.id}** ${rule.text ?? "A statement."}`),
    "",
    "## Gaps",
    "",
    "- **AA-G1** [builder] A gap.",
    "",
    "## Provenance",
    "",
    "| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rules.map((rule) => {
      const slice = rule.slice === "-" ? "-" : `\`${rule.slice}\``
      return `| ${rule.id} | TIM-1 item 2 | ${rule.agreedBy ?? "Tim"} | not run | TIM-3 | \`${rule.kind ?? "rule"}\` | ${slice} |`
    }),
  ].join("\n")

const table = (
  heading: string,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
) =>
  [
    `## ${heading}`,
    "",
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n")

interface Fixture {
  readonly rules: ReadonlyArray<FixtureRule>
  readonly delivered?: ReadonlyArray<string>
  readonly held?: ReadonlyArray<
    readonly [unit: string, slice: string, reason: string]
  >
  readonly stopped?: ReadonlyArray<readonly [id: string, reason: string]>
  readonly tests?: ReadonlyArray<readonly [name: string, project?: string]>
  readonly sources?: Readonly<Record<string, string>>
}

const parts = (rules: ReadonlyArray<FixtureRule>) => ({
  "01-a-part.md": part(rules),
  "19-build-order.md": buildOrder,
})

const run = (fixture: Fixture) =>
  evaluate({
    parts: parts(fixture.rules),
    delivered: [
      "## Slices",
      "",
      ...(fixture.delivered ?? ["early"]).map((slice) => `- \`${slice}\``),
      "",
      table(
        "Held rules",
        ["Rule", "Slice", "Reason"],
        (fixture.held ?? []).map(([unit, slice, reason]) => [
          unit,
          `\`${slice}\``,
          reason,
        ]),
      ),
      "",
      table("Stopped rules", ["Rule", "What is wrong"], fixture.stopped ?? []),
    ].join("\n"),
    tests: (fixture.tests ?? []).map(
      ([name, projectName = "unit"]): ListedTest => ({
        name,
        file: "test/a.test.ts",
        projectName,
      }),
    ),
    sources: fixture.sources ?? {},
  })

const early = { id: "AA-1", slice: "early" }
const late = { id: "AA-2", slice: "late" }

describe("the rule index", () => {
  it("TST-171 is built from the Provenance tables, whose rows are the only rule ids", () => {
    const spec = parseSpec({
      "01-a-part.md": [
        "| Id | Statement |",
        "| --- | --- |",
        "| **AA-2** | A rule that is a table row. |",
        part([
          {
            id: "AA-1",
            slice: "early",
            agreedBy: "Architect (Tim has not read)",
          },
          late,
        ]),
      ].join("\n"),
    })
    expect([...spec.rules.keys()]).toEqual(["AA-1", "AA-2"])
    expect(spec.rules.get("AA-1")).toMatchObject({
      id: "AA-1",
      part: "01-a-part.md",
      agreedBy: "Architect (Tim has not read)",
      support: "not run",
      changedBy: "TIM-3",
      kind: "rule",
      slice: "early",
    })
    expect(spec.rules.get("AA-2")?.text).toBe(
      "| **AA-2** | A rule that is a table row. |",
    )
  })

  it("TST-6 fails on an id that two parts both give a row", () => {
    const report = evaluate({
      parts: { ...parts([early]), "02-another.md": part([early]) },
      delivered: "",
      tests: [],
      sources: {},
    })
    expect(report.failures).toContainEqual(
      expect.stringContaining(
        "AA-1 has a Provenance row in 01-a-part.md and in 02-another.md",
      ),
    )
  })

  it("TST-194 show prints one rule with where it is, its section and its Provenance row", () => {
    const shown = show(
      parts([{ ...early, text: "The first statement." }, late]),
      "AA-1",
    )
    expect(shown?.split("\n")).toEqual([
      "docs/spec/01-a-part.md:5",
      "## A section",
      "",
      "- **AA-1** The first statement.",
      "",
      "| AA-1 | TIM-1 item 2 | Tim | not run | TIM-3 | `rule` | `early` |",
    ])
    expect(show(parts([early, late]), "AA-1", true)).toContain(
      "- **AA-2** A statement.",
    )
    expect(show(parts([early]), "AA-9")).toBeUndefined()
    expect(list(parts([early, late]), "late")).toEqual(["AA-2"])
  })
})

describe("the comparison of the spec's ids with the tests' ids", () => {
  it("TST-7 TST-14 wants no test for a rule of a delivered slice, and takes a test whose title names no rule id", () => {
    const report = run({ rules: [early, late], tests: [["decodes UTF-8"]] })
    expect(report.failures).toEqual([])
    expect(report.index.map((entry) => entry.units)).toEqual([
      [{ unit: "AA-1", status: "delivered" }],
      [{ unit: "AA-2", status: "pending", reason: "late" }],
    ])
  })

  it("TST-8 TST-12 indexes only the tests that vitest lists in a project of the gate", () => {
    const report = run({
      rules: [early],
      tests: [["AA-1 holds"], ["AA-1 on a real login", "codex"]],
      sources: { "test/b.test.ts": 'it("AA-1 in the source only", () => {})' },
    })
    expect(report.failures).toEqual([])
    expect(report.index[0]?.tests).toEqual([
      {
        name: "AA-1 holds",
        file: "test/a.test.ts",
        projectName: "unit",
        unit: "AA-1",
      },
    ])
  })

  it("TST-10 fails on a test that names an id the spec does not have", () => {
    const report = run({ rules: [early], tests: [["AA-1 AA-7 hold"]] })
    expect(report.failures).toEqual([
      'test/a.test.ts: "AA-1 AA-7 hold" names AA-7, which the spec does not have',
    ])
  })

  it("TST-11 fails on a skip, a todo and an only, none of which vitest lists", () => {
    // The modifier is spliced in, so that this file does not itself hold one.
    const call = (test: string, modifier: string, title: string) =>
      `${test}.${modifier}("${title}", () => {})`
    const option = (test: string, key: string, title: string) =>
      `${test}("${title}", { ${key}: true }, () => {})`
    const report = run({
      rules: [early],
      tests: [["AA-1 holds"]],
      sources: {
        "test/a.test.ts": [
          'it("AA-1 holds", () => {})',
          call("it", "skip", "AA-1 later"),
          call("it", "todo", "AA-1 soon"),
        ].join("\n"),
        "test/b.test.ts": call("describe", "only", "AA-1"),
        "test/c.test.ts": [
          option("it", "skip", "AA-1 later"),
          option("describe", "todo", "AA-1"),
          'it("AA-1 soon", {',
          "  timeout: 1000,",
          `  ${"only"},`,
          "}, () => {})",
        ].join("\n"),
      },
    })
    expect(report.failures).toEqual([
      "test/a.test.ts:2 uses skip, and no test is skipped, todo or only",
      "test/a.test.ts:3 uses todo, and no test is skipped, todo or only",
      "test/b.test.ts:1 uses only, and no test is skipped, todo or only",
      "test/c.test.ts:1 uses skip, and no test is skipped, todo or only",
      "test/c.test.ts:2 uses todo, and no test is skipped, todo or only",
      "test/c.test.ts:5 uses only, and no test is skipped, todo or only",
    ])
  })

  it("TST-190 takes a letter after an id that the rule's text marks, and no other", () => {
    const lettered = {
      id: "AA-1",
      slice: "early",
      text: "(a) One statement. (b) Another.",
    }
    expect(
      run({ rules: [lettered], tests: [["AA-1a holds"], ["AA-1 holds"]] })
        .failures,
    ).toEqual([])
    expect(
      run({ rules: [lettered], tests: [["AA-1a AA-1b AA-1c hold"]] }).failures,
    ).toEqual([
      'test/a.test.ts: "AA-1a AA-1b AA-1c hold" names AA-1c, which the spec does not have',
    ])
    const unsliced = { ...lettered, slice: "-", kind: "definition" }
    expect(
      run({ rules: [unsliced], tests: [["AA-1a AA-1z hold"]] }).failures,
    ).toEqual([
      'test/a.test.ts: "AA-1a AA-1z hold" names AA-1z, which the spec does not have',
    ])
  })

  it("TST-172 never leaves a rule whose slice is - pending, and indexes it as a definition or as withdrawn", () => {
    const report = run({
      rules: [
        { id: "AA-1", slice: "-", kind: "definition" },
        { id: "AA-3", slice: "-", kind: "rule", text: "Withdrawn." },
      ],
      delivered: [],
    })
    expect(report.failures).toEqual([])
    expect(report.pending).toEqual({})
    expect(report.index.map((entry) => entry.units[0]?.status)).toEqual([
      "definition",
      "withdrawn",
    ])
  })

  it("TST-83 has no option that leaves a test out of the comparison", () => {
    expect(command([])).toEqual({ mode: "check" })
    expect(() => command(["--exclude", "test/a.test.ts"])).toThrow("usage")
    expect(() => command(["check", "--quarantine", "AA-1"])).toThrow("usage")
  })
})

describe("the delivered file", () => {
  it("TST-14 ORD-10 leaves a rule pending while its slice is not in the delivered file", () => {
    const report = run({ rules: [early, late], tests: [["AA-1 holds"]] })
    expect(report.failures).toEqual([])
    expect(report.pending).toEqual({ late: 1 })
    expect(
      run({ rules: [early, late], delivered: ["early", "late"] }),
    ).toMatchObject({ failures: [], pending: {} })
  })

  it("ORD-11 holds a rule, or one letter of a rule, for a later slice with a reason", () => {
    const lettered = {
      id: "AA-1",
      slice: "early",
      text: "(a) One statement. (b) Another.",
    }
    const held = run({
      rules: [lettered, { id: "AA-3", slice: "early" }],
      tests: [["AA-1a holds"]],
      held: [
        ["AA-1b", "late", "It rests on the rest."],
        ["AA-3", "late", "It rests on the rest."],
      ],
    })
    expect(held.failures).toEqual([])
    expect(held.pending).toEqual({ late: 2 })
    expect(
      run({ rules: [early], held: [["AA-1", "late", ""]] }).failures,
    ).toEqual(["the held entry AA-1 gives no reason"])
  })

  it("ORD-12 fails on a held entry once the slice it names is delivered", () => {
    const fixture = {
      rules: [early, late],
      held: [["AA-1", "late", "It rests on the rest."]],
      tests: [["AA-2 holds"]],
    } as const
    expect(run(fixture).failures).toEqual([])
    expect(
      run({
        ...fixture,
        delivered: ["early", "late"],
        tests: [["AA-1 AA-2 hold"]],
      }).failures,
    ).toEqual([
      "AA-1 is held for late, which is delivered, so the held entry has to go",
    ])
    expect(
      run({ ...fixture, delivered: ["early", "late"], held: [] }).failures,
    ).toEqual([])
  })

  it("ORD-40 fails on a slice the build order does not have, and on a held entry for the rule's own slice", () => {
    expect(
      run({
        rules: [early],
        tests: [["AA-1 holds"]],
        delivered: ["early", "lite"],
      }).failures,
    ).toEqual([
      "the delivered file names the slice lite, which the build order does not have",
    ])
    expect(
      run({ rules: [early], held: [["AA-1", "lite", "It rests on the rest."]] })
        .failures,
    ).toContain(
      "the held entry AA-1 names the slice lite, which the build order does not have",
    )
    expect(
      run({ rules: [early], held: [["AA-1", "early", "It is hard."]] })
        .failures,
    ).toContain(
      "the held entry AA-1 names early, which is the rule's own slice",
    )
  })

  it("ORD-42 leaves a stopped rule pending and prints it, and fails on one that is unknown, withdrawn or also held", () => {
    const stopped = run({
      rules: [early],
      stopped: [["AA-1", "It names a flag that clanka does not have."]],
    })
    expect(stopped.failures).toEqual([])
    expect(stopped.pending).toEqual({ stopped: 1 })
    expect(summary(stopped)).toContain(
      "stopped: 1\n  AA-1: It names a flag that clanka does not have.",
    )

    const withdrawn = {
      id: "AA-3",
      slice: "-",
      kind: "rule",
      text: "Withdrawn.",
    }
    const failures = (fixture: Partial<Fixture>, id = "AA-1") =>
      run({
        rules: [early, late, withdrawn],
        stopped: [[id, "It is wrong."]],
        ...fixture,
      }).failures
    expect(failures({ tests: [["AA-1 holds"]] }, "AA-9")).toEqual([
      "the stopped entry AA-9 names a rule the spec does not have",
    ])
    expect(failures({ tests: [["AA-1 holds"]] }, "AA-3")).toEqual([
      "the stopped entry AA-3 names a withdrawn rule",
    ])
    expect(failures({ tests: [["AA-1 holds"]] })).toEqual([])
    expect(
      failures({ held: [["AA-1", "late", "It rests on the rest."]] }),
    ).toEqual(["the stopped rule AA-1 also has a held entry"])
  })

  it("ORD-42 ORD-11 stops one letter of a rule, leaves its other letters delivered, and fails on a letter the rule's text does not mark", () => {
    const lettered = {
      id: "AA-1",
      slice: "early",
      text: "(a) One statement. (b) Another.",
    }
    const report = run({
      rules: [lettered],
      delivered: ["early"],
      stopped: [["AA-1b", "It is wrong."]],
    })
    expect(report.failures).toEqual([])
    expect(report.pending).toEqual({ stopped: 1 })
    expect(
      report.index.find((entry) => entry.id === "AA-1")?.units,
    ).toMatchObject([
      { unit: "AA-1a", status: "delivered" },
      { unit: "AA-1b", status: "stopped" },
    ])
    expect(
      run({
        rules: [lettered],
        stopped: [["AA-1c", "It is wrong."]],
      }).failures,
    ).toEqual(["the stopped entry AA-1c names a rule the spec does not have"])
  })
})
