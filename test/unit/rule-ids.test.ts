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
  readonly waivers?: ReadonlyArray<readonly [unit: string, coveredBy: string]>
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
    waivers: table("Waivers", ["Rule", "Covered by"], fixture.waivers ?? []),
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
      waivers: "",
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
  it("TST-9 fails on a rule of a delivered slice that has no test", () => {
    expect(run({ rules: [early] }).failures).toEqual([
      "AA-1 (01-a-part.md, slice early) has no test, is not pending and is not on the waiver list",
    ])
    expect(run({ rules: [early], tests: [["AA-1 holds"]] }).failures).toEqual(
      [],
    )
  })

  it("TST-8 counts only the tests that vitest lists in a project of the gate", () => {
    const inSourceOnly = run({
      rules: [early],
      sources: { "test/a.test.ts": 'it("AA-1 holds", () => {})' },
    })
    expect(inSourceOnly.failures).toContainEqual(
      expect.stringContaining("AA-1 (01-a-part.md, slice early) has no test"),
    )
    const nightlyOnly = run({
      rules: [early],
      tests: [["AA-1 holds", "discord"]],
    })
    expect(nightlyOnly.failures).toContainEqual(
      expect.stringContaining("AA-1 (01-a-part.md, slice early) has no test"),
    )
  })

  it("TST-7 TST-173 fails on a test whose title names no rule id", () => {
    const report = run({
      rules: [early],
      tests: [["AA-1 holds"], ["decodes UTF-8"]],
    })
    expect(report.failures).toEqual([
      'test/a.test.ts: "decodes UTF-8" names no rule id',
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

  it("TST-190 takes a letter after an id, and wants a test for each letter the rule's text carries", () => {
    const lettered = {
      id: "AA-1",
      slice: "early",
      text: "(a) One statement. (b) Another.",
    }
    expect(
      run({ rules: [lettered], tests: [["AA-1a holds"], ["AA-1b holds"]] })
        .failures,
    ).toEqual([])
    expect(
      run({ rules: [lettered], tests: [["AA-1a holds"], ["AA-1 holds"]] })
        .failures,
    ).toEqual([
      "AA-1b (01-a-part.md, slice early) has no test, is not pending and is not on the waiver list",
    ])
    expect(
      run({ rules: [lettered], tests: [["AA-1a AA-1b AA-1c hold"]] }).failures,
    ).toEqual([
      'test/a.test.ts: "AA-1a AA-1b AA-1c hold" names AA-1c, which the spec does not have',
    ])
  })

  it("TST-16 fails on an untested rule that Architect agreed, as on any other", () => {
    const report = run({
      rules: [{ ...early, agreedBy: "Architect (Tim has not read)" }],
    })
    expect(report.failures).toHaveLength(1)
  })

  it("TST-172 wants no test for a rule whose slice is -, and counts it as a definition or as withdrawn", () => {
    const report = run({
      rules: [
        { id: "AA-1", slice: "-", kind: "definition" },
        { id: "AA-2", slice: "-", kind: "definition" },
        { id: "AA-3", slice: "-", kind: "rule", text: "Withdrawn." },
      ],
      delivered: [],
    })
    expect(report.failures).toEqual([])
    expect(report.waived).toEqual({ definition: 2, withdrawn: 1 })
    expect(report.pending).toEqual({})
  })

  it("TST-193 prints the number of waived rules for each waiver reason", () => {
    const report = run({
      rules: [
        { id: "AA-1", slice: "-", kind: "definition" },
        { id: "AA-2", slice: "-", kind: "rule", text: "Withdrawn." },
        { id: "AA-3", slice: "early" },
        { id: "AA-4", slice: "early", kind: "fact" },
        { id: "AA-5", slice: "early" },
      ],
      waivers: [
        ["AA-3", "discord"],
        ["AA-4", "AA-5"],
      ],
      tests: [["AA-3 on a real gateway", "discord"], ["AA-5 holds"]],
    })
    expect(report.failures).toEqual([])
    expect(summary(report).split("\n")).toEqual(
      expect.arrayContaining([
        "waived, by reason:",
        "  definition: 1",
        "  withdrawn: 1",
        "  discord: 1",
        "  fact: 1",
      ]),
    )
  })

  it("TST-13 TST-192 takes a waiver that names an item which carries the rule's id, or for a fact a rule with a test", () => {
    const rules = [
      early,
      { id: "AA-3", slice: "early", kind: "fact" },
      { id: "AA-4", slice: "-", kind: "definition" },
    ]
    const failures = (
      waivers: NonNullable<Fixture["waivers"]>,
      tests: NonNullable<Fixture["tests"]> = [],
    ) => run({ rules, waivers, tests: [["AA-1 AA-3 hold"], ...tests] }).failures
    expect(
      failures([["AA-1", "discord"]], [["AA-1 on a real gateway", "discord"]]),
    ).toEqual([])
    expect(failures([["AA-3", "AA-1"]])).toEqual([])
    expect(
      failures([["AA-1", "discord"]], [["AA-3 on a real gateway", "discord"]]),
    ).toEqual([
      "the waiver AA-1 names the item discord, which does not carry the rule's id",
    ])
    expect(failures([["AA-1", "Tim has not read it"]])).toEqual([
      "the waiver AA-1 names Tim has not read it, which is no nightly or live item",
    ])
    expect(failures([["AA-1", "unit"]])).toEqual([
      "the waiver AA-1 names unit, which is no nightly or live item",
    ])
    expect(failures([["AA-1", "AA-3"]])).toEqual([
      "the waiver AA-1 names the rule AA-3 in place of an item, and only a fact may",
    ])
    expect(failures([["AA-3", "AA-4"]])).toEqual([
      "the waiver AA-3 names AA-4, which has no test that could fail",
    ])
    // A fact names a rule and never an item, and the rule may be one that only an item covers.
    expect(
      failures([["AA-3", "discord"]], [["AA-3 on a real gateway", "discord"]]),
    ).toEqual([
      "the waiver AA-3 is of a fact and names discord, and a fact names the rule whose test would fail if it stopped holding",
    ])
    expect(
      run({
        rules: [
          early,
          { id: "AA-7", slice: "early" },
          { id: "AA-8", slice: "early", kind: "fact" },
        ],
        waivers: [
          ["AA-8", "AA-7"],
          ["AA-7", "discord"],
        ],
        tests: [["AA-1 holds"], ["AA-7 on a real gateway", "discord"]],
      }),
    ).toMatchObject({ failures: [], waived: { fact: 1, discord: 1 } })
    // Two facts with no test, each waived against the other, cover nothing.
    const facts = [
      early,
      { id: "AA-5", slice: "early", kind: "fact" },
      { id: "AA-6", slice: "early", kind: "fact" },
    ]
    const each = (waivers: NonNullable<Fixture["waivers"]>) =>
      run({ rules: facts, waivers, tests: [["AA-1 holds"]] })
    expect(
      each([
        ["AA-5", "AA-1"],
        ["AA-6", "AA-1"],
      ]),
    ).toMatchObject({ failures: [], waived: { fact: 2 } })
    expect(
      each([
        ["AA-5", "AA-6"],
        ["AA-6", "AA-5"],
      ]).failures,
    ).toEqual([
      "the waiver AA-5 names AA-6, which has no test that could fail",
      "the waiver AA-6 names AA-5, which has no test that could fail",
      "AA-5 (01-a-part.md, slice early) has no test, is not pending and is not on the waiver list",
      "AA-6 (01-a-part.md, slice early) has no test, is not pending and is not on the waiver list",
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
      run({
        rules: [early, late],
        tests: [["AA-1 holds"]],
        delivered: ["early", "late"],
      }).failures,
    ).toEqual([
      "AA-2 (01-a-part.md, slice late) has no test, is not pending and is not on the waiver list",
    ])
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

  it("ORD-12 fails on a held entry once the slice it names is delivered, and on the rule while it has no test", () => {
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
    ).toEqual([
      "AA-1 (01-a-part.md, slice early) has no test, is not pending and is not on the waiver list",
    ])
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

  it("ORD-42 leaves a stopped rule pending and prints it, and fails on one that is unknown, withdrawn or also tested", () => {
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
    expect(failures({ tests: [["AA-1 holds"]] })).toEqual([
      "the stopped rule AA-1 also has a test",
    ])
    expect(
      failures({ held: [["AA-1", "late", "It rests on the rest."]] }),
    ).toEqual(["the stopped rule AA-1 also has a held entry"])
    expect(
      failures({
        waivers: [["AA-1", "discord"]],
        tests: [["AA-1 on a real gateway", "discord"]],
      }),
    ).toEqual(["the stopped rule AA-1 also has a waiver"])
  })
})
