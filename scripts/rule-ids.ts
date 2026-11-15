// The rule-id script of docs/spec/17-testing.md and docs/spec/19-build-order.md.
//
//   node scripts/rule-ids.ts                  compare the spec's rule ids with the tests' (CI)
//   node scripts/rule-ids.ts show <id>        print one rule, --section prints its whole section
//   node scripts/rule-ids.ts list <slice>     print the rule ids of one slice
//
// It runs on Node alone, with no dependency, so `show` and `list` work before an install.
import { spawnSync } from "node:child_process"
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The vitest projects the pull request gate runs, one per layer. Any other project is a live item. */
export const gateProjects = ["types", "unit", "daemon", "process", "image"]

export const deliveredFile = "delivered.md"

export interface Rule {
  readonly id: string
  readonly part: string
  readonly source: string
  readonly agreedBy: string
  readonly support: string
  readonly changedBy: string
  readonly kind: string
  readonly slice: string
  /** The line of the rule's text in its part, or 0 when the part holds a Provenance row and no text. */
  readonly line: number
  readonly text: string
  readonly section: string
  readonly row: string
  /** The letters the rule's text marks as (a), (b) and so on. A test or a held entry may name these and no other. */
  readonly letters: ReadonlyArray<string>
}

/** One entry of `vitest list --json`. */
export interface ListedTest {
  readonly name: string
  readonly file: string
  readonly projectName?: string | undefined
}

export interface Inputs {
  /** The parts of the spec by file name, such as `17-testing.md`. */
  readonly parts: Readonly<Record<string, string>>
  readonly delivered: string
  readonly tests: ReadonlyArray<ListedTest>
  /** The source of every test file by path, read only to find skip, todo and only. */
  readonly sources: Readonly<Record<string, string>>
}

export interface Held {
  readonly unit: string
  readonly slice: string
  readonly reason: string
}

export interface Stopped {
  readonly id: string
  readonly reason: string
}

/** A rule with no slice is a definition or withdrawn. A rule of a delivered slice that is not held or stopped is delivered. */
export type Status =
  "definition" | "withdrawn" | "pending" | "held" | "stopped" | "delivered"

export interface IndexEntry {
  readonly id: string
  readonly part: string
  readonly agreedBy: string
  readonly support: string
  readonly changedBy: string
  readonly kind: string
  readonly slice: string
  readonly units: ReadonlyArray<{
    readonly unit: string
    readonly status: Status
    readonly reason?: string
  }>
  /** The gate's tests that name the rule or one of its letters, each with the unit it names. */
  readonly tests: ReadonlyArray<ListedTest & { readonly unit: string }>
}

export interface Report {
  readonly failures: ReadonlyArray<string>
  readonly index: ReadonlyArray<IndexEntry>
  /** The number of pending rules for each slice that is not delivered, held rules included. */
  readonly pending: Readonly<Record<string, number>>
  readonly stopped: ReadonlyArray<Stopped>
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())

const unquote = (cell: string) => cell.replace(/^`(.*)`$/, "$1")

const partName = /^\d\d-.*\.md$/
const ruleId = /^[A-Z]+-\d+$/

export interface Spec {
  readonly rules: ReadonlyMap<string, Rule>
  /** The slices in build order, each with its stage. */
  readonly slices: ReadonlyArray<{
    readonly name: string
    readonly stage: number
  }>
  readonly failures: ReadonlyArray<string>
}

/** Builds the rule index from the Provenance tables, which are the only source of rule ids. */
export const parseSpec = (parts: Readonly<Record<string, string>>): Spec => {
  const rules = new Map<string, Rule>()
  const slices: Array<{ name: string; stage: number }> = []
  const failures: Array<string> = []
  for (const part of Object.keys(parts).sort()) {
    if (!partName.test(part)) continue
    const lines = parts[part]!.split("\n")
    const provenance = lines.findIndex(
      (line) => line.trim() === "## Provenance",
    )
    const texts = new Map<
      string,
      { line: number; text: string; section: string }
    >()
    let section = ""
    let inSlices = false
    lines.forEach((line, index) => {
      if (provenance !== -1 && index >= provenance) return
      if (line.startsWith("#")) {
        section = line.replace(/^#+\s*/, "")
        inSlices = section === "Slices"
        return
      }
      const slice = inSlices ? /^\| `([a-z-]+)` \| (\d+) \|/.exec(line) : null
      if (slice) slices.push({ name: slice[1]!, stage: Number(slice[2]) })
      const text = /^(?:- |\| )\*\*([A-Z]+-\d+)\*\*/.exec(line)
      if (text && !texts.has(text[1]!))
        texts.set(text[1]!, { line: index + 1, text: line, section })
    })
    if (provenance === -1) continue
    for (const row of lines.slice(provenance + 1)) {
      if (row.startsWith("## ")) break
      const columns = cells(row)
      const id = columns[0] ?? ""
      if (!row.startsWith("|") || !ruleId.test(id)) continue
      if (rules.has(id)) {
        failures.push(
          `${id} has a Provenance row in ${rules.get(id)!.part} and in ${part}, and an id is never reused`,
        )
        continue
      }
      if (columns.length !== 7) {
        failures.push(
          `${id} in ${part} has a Provenance row of ${columns.length} cells, expected 7`,
        )
        continue
      }
      const text = texts.get(id)
      const slice = unquote(columns[6]!)
      const marked = [
        ...new Set(
          [...(text?.text ?? "").matchAll(/\(([a-z])\)/g)].map(
            (match) => match[1]!,
          ),
        ),
      ].sort()
      rules.set(id, {
        id,
        part,
        source: columns[1]!,
        agreedBy: columns[2]!,
        support: columns[3]!,
        changedBy: columns[4]!,
        kind: unquote(columns[5]!),
        slice,
        line: text?.line ?? 0,
        text: text?.text ?? "",
        section: text?.section ?? "",
        row,
        letters: marked,
      })
    }
  }
  return { rules, slices, failures }
}

const sectionsOf = (markdown: string) => {
  const sections = new Map<string, Array<string>>()
  let current: Array<string> | undefined
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      current = []
      sections.set(line.slice(3).trim(), current)
    } else if (current) current.push(line)
  }
  return sections
}

const tableRows = (lines: ReadonlyArray<string> | undefined) =>
  (lines ?? [])
    .filter((line) => line.startsWith("|"))
    .map(cells)
    .slice(2)

/** Reads the delivered file: the delivered slices, the held rules and the stopped rules. */
export const parseDelivered = (
  markdown: string,
): {
  readonly slices: ReadonlyArray<string>
  readonly held: ReadonlyArray<Held>
  readonly stopped: ReadonlyArray<Stopped>
} => {
  const sections = sectionsOf(markdown)
  return {
    slices: (sections.get("Slices") ?? []).flatMap((line) => {
      const match = /^- `([^`]+)`$/.exec(line.trim())
      return match ? [match[1]!] : []
    }),
    held: tableRows(sections.get("Held rules")).map((row) => ({
      unit: row[0] ?? "",
      slice: unquote(row[1] ?? ""),
      reason: row[2] ?? "",
    })),
    stopped: tableRows(sections.get("Stopped rules")).map((row) => ({
      id: row[0] ?? "",
      reason: row[1] ?? "",
    })),
  }
}

const splitUnit = (unit: string) => {
  const match = /^([A-Z]+-\d+)([a-z])?$/.exec(unit)
  return match ? { id: match[1]!, letter: match[2] } : undefined
}

const unitsOf = (rule: Rule) =>
  rule.letters.length === 0
    ? [rule.id]
    : rule.letters.map((letter) => rule.id + letter)

// A skip, a todo or an only is written as a modifier, `it.skip(...)`, or as a key of the options a test or a suite
// takes, `it("...", { skip: true }, ...)`. vitest lists neither, so both are found in the source. A key is a name
// before a colon, quoted or not, or a bare name that stands as a shorthand property.
const skips = [
  /\.(skip|todo|only|skipIf|runIf)\s*[(.`]/,
  /(?:^|[{,])\s*["'](skip|todo|only)["']\s*:/,
  /(?:^|[{,])\s*(skip|todo|only)\s*(?:[:,}]|$)/,
]

/** Compares the rule ids of the spec with the ids the tests name. */
export const evaluate = (inputs: Inputs): Report => {
  const spec = parseSpec(inputs.parts)
  const failures = [...spec.failures]
  const prefixes = new Set(
    [...spec.rules.keys()].map((id) => id.slice(0, id.indexOf("-"))),
  )
  const sliceNames = new Set(spec.slices.map((slice) => slice.name))

  // The units of a rule are its letters, or the rule itself when its text carries none.
  const resolve = (unit: string) => {
    const parsed = splitUnit(unit)
    const rule = parsed && spec.rules.get(parsed.id)
    if (!parsed || !rule) return undefined
    if (parsed.letter === undefined) return { rule, units: unitsOf(rule) }
    return rule.letters.includes(parsed.letter)
      ? { rule, units: [unit] }
      : undefined
  }

  // A test need name no rule id. One that names an id or a letter the spec lacks fails, in any project.
  const gateTests = new Map<string, Array<ListedTest & { unit: string }>>()
  for (const test of inputs.tests) {
    const where = `${test.file}: "${test.name}"`
    const named = [...test.name.matchAll(/\b([A-Z]+)-(\d+)([a-z])?\b/g)].filter(
      (match) => prefixes.has(match[1]!),
    )
    for (const match of named) {
      const unit = match[0]
      const rule = spec.rules.get(`${match[1]}-${match[2]}`)
      if (
        !rule ||
        (match[3] !== undefined && !rule.letters.includes(match[3]))
      ) {
        failures.push(`${where} names ${unit}, which the spec does not have`)
        continue
      }
      if (gateProjects.includes(test.projectName ?? ""))
        gateTests.set(rule.id, [
          ...(gateTests.get(rule.id) ?? []),
          { ...test, unit },
        ])
    }
  }

  for (const [file, source] of Object.entries(inputs.sources)) {
    source.split("\n").forEach((line, index) => {
      const match = skips
        .map((pattern) => pattern.exec(line))
        .find((found) => found !== null)
      if (match)
        failures.push(
          `${file}:${index + 1} uses ${match[1]}, and no test is skipped, todo or only`,
        )
    })
  }

  const delivered = parseDelivered(inputs.delivered)
  for (const slice of delivered.slices) {
    if (!sliceNames.has(slice))
      failures.push(
        `the delivered file names the slice ${slice}, which the build order does not have`,
      )
  }
  const isDelivered = (slice: string) => delivered.slices.includes(slice)

  const held = new Map<string, Held>()
  for (const entry of delivered.held) {
    const target = resolve(entry.unit)
    if (!target) {
      failures.push(
        `the held entry ${entry.unit} names a rule or a letter the spec does not have`,
      )
    } else if (!sliceNames.has(entry.slice)) {
      failures.push(
        `the held entry ${entry.unit} names the slice ${entry.slice}, which the build order does not have`,
      )
    } else if (entry.slice === target.rule.slice) {
      failures.push(
        `the held entry ${entry.unit} names ${entry.slice}, which is the rule's own slice`,
      )
    } else {
      if (entry.reason === "")
        failures.push(`the held entry ${entry.unit} gives no reason`)
      for (const unit of target.units) held.set(unit, entry)
    }
  }

  const stopped = new Map<string, Stopped>()
  for (const entry of delivered.stopped) {
    const rule = spec.rules.get(entry.id)
    if (!rule) {
      failures.push(
        `the stopped entry ${entry.id} names a rule the spec does not have`,
      )
    } else if (rule.slice === "-" && rule.kind !== "definition") {
      failures.push(`the stopped entry ${entry.id} names a withdrawn rule`)
    } else {
      stopped.set(entry.id, entry)
      if (unitsOf(rule).some((unit) => held.has(unit)))
        failures.push(`the stopped rule ${entry.id} also has a held entry`)
    }
  }

  const pending: Record<string, number> = {}
  const count = (key: string) => {
    pending[key] = (pending[key] ?? 0) + 1
  }
  const index = [...spec.rules.values()].map((rule): IndexEntry => {
    const units = unitsOf(rule).map((unit) => {
      const entry = held.get(unit)
      if (rule.slice === "-")
        return {
          unit,
          status:
            rule.kind === "definition"
              ? ("definition" as const)
              : ("withdrawn" as const),
        }
      if (stopped.has(rule.id))
        return {
          unit,
          status: "stopped" as const,
          reason: stopped.get(rule.id)!.reason,
        }
      if (!isDelivered(rule.slice))
        return { unit, status: "pending" as const, reason: rule.slice }
      if (entry && !isDelivered(entry.slice))
        return { unit, status: "held" as const, reason: entry.slice }
      if (entry)
        failures.push(
          `${unit} is held for ${entry.slice}, which is delivered, so the held entry has to go`,
        )
      return { unit, status: "delivered" as const }
    })
    // A rule counts once, by the least settled of its units.
    const order: ReadonlyArray<Status> = ["stopped", "pending", "held"]
    const worst = units
      .filter((unit) => order.includes(unit.status))
      .toSorted((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0]
    if (worst?.status === "stopped") count("stopped")
    else if (worst) count(worst.reason!)
    return {
      id: rule.id,
      part: rule.part,
      agreedBy: rule.agreedBy,
      support: rule.support,
      changedBy: rule.changedBy,
      kind: rule.kind,
      slice: rule.slice,
      units,
      tests: gateTests.get(rule.id) ?? [],
    }
  })
  const inBuildOrder = Object.fromEntries(
    [...spec.slices.map((slice) => slice.name), "stopped"].flatMap((key) =>
      pending[key] === undefined ? [] : [[key, pending[key]]],
    ),
  )
  return {
    failures,
    index,
    pending: inBuildOrder,
    stopped: [...stopped.values()],
  }
}

/** What the comparison prints: the number of rules, the counts of pending rules by slice, and the stopped rules. */
export const summary = (report: Report): string => {
  const table = (record: Readonly<Record<string, number>>) =>
    Object.entries(record).map(([key, value]) => `  ${key}: ${value}`)
  return [
    `rules: ${report.index.length}`,
    "pending, by slice:",
    ...table(report.pending),
    `stopped: ${report.stopped.length}`,
    ...report.stopped.map((entry) => `  ${entry.id}: ${entry.reason}`),
  ].join("\n")
}

/** What `show <id>` prints: the rule's text, where it is, its section heading and its Provenance row. */
export const show = (
  parts: Readonly<Record<string, string>>,
  id: string,
  wholeSection = false,
): string | undefined => {
  const rule = parseSpec(parts).rules.get(id)
  if (!rule) return undefined
  const lines = parts[rule.part]!.split("\n")
  let text = rule.text
  if (wholeSection && rule.line > 0) {
    const isHeading = (line: string) => line.startsWith("#")
    const start = lines.findLastIndex(
      (line, index) => index < rule.line && isHeading(line),
    )
    const end = lines.findIndex(
      (line, index) => index >= rule.line && isHeading(line),
    )
    text = lines
      .slice(start + 1, end === -1 ? lines.length : end)
      .join("\n")
      .trim()
  }
  return [
    `docs/spec/${rule.part}:${rule.line}`,
    `## ${rule.section}`,
    "",
    text,
    "",
    rule.row,
  ].join("\n")
}

/** The rule ids of one slice, in the order of the parts. */
export const list = (
  parts: Readonly<Record<string, string>>,
  slice: string,
): ReadonlyArray<string> =>
  [...parseSpec(parts).rules.values()]
    .filter((rule) => rule.slice === slice)
    .map((rule) => rule.id)

export type Command =
  | { readonly mode: "check" }
  | { readonly mode: "show"; readonly id: string; readonly section: boolean }
  | { readonly mode: "list"; readonly slice: string }

/** Reads the command line. It has no option that leaves a test or a rule out of the comparison. */
export const command = (argv: ReadonlyArray<string>): Command => {
  const [mode, ...rest] = argv
  if (mode === undefined && rest.length === 0) return { mode: "check" }
  if (
    mode === "show" &&
    rest.length >= 1 &&
    rest.slice(1).every((arg) => arg === "--section")
  ) {
    return { mode: "show", id: rest[0]!, section: rest.length > 1 }
  }
  if (mode === "list" && rest.length === 1)
    return { mode: "list", slice: rest[0]! }
  throw new Error(
    "usage: rule-ids.ts | rule-ids.ts show <id> [--section] | rule-ids.ts list <slice>",
  )
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const specDir = join(root, "docs/spec")

const readParts = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(specDir)
      .filter((file) => partName.test(file))
      .map((file) => [file, readFileSync(join(specDir, file), "utf8")]),
  )

/**
 * The tests of every project, as `vitest list --json` prints them. vitest parses the files statically by default,
 * which misses a computed title and takes any call that looks like a test for one, so the files are collected for real.
 */
const listTests = (): ReadonlyArray<ListedTest> => {
  const directory = mkdtempSync(join(tmpdir(), "rule-ids-"))
  try {
    const file = join(directory, "list.json")
    const result = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "list",
        "--staticParse=false",
        `--json=${file}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    )
    if (result.status !== 0)
      throw new Error(`vitest list failed:\n${result.stdout}${result.stderr}`)
    return JSON.parse(readFileSync(file, "utf8"))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const check = () => {
  const tests = listTests().map((test) => ({
    ...test,
    file: relative(root, test.file),
  }))
  const files = new Set([
    ...tests.map((test) => test.file),
    ...globSync("test/**/*.test.ts", { cwd: root }),
  ])
  const report = evaluate({
    parts: readParts(),
    delivered: readFileSync(join(specDir, deliveredFile), "utf8"),
    tests,
    sources: Object.fromEntries(
      [...files].map((file) => [file, readFileSync(join(root, file), "utf8")]),
    ),
  })
  mkdirSync(join(root, ".rule-ids"), { recursive: true })
  writeFileSync(
    join(root, ".rule-ids/index.json"),
    JSON.stringify(report.index, null, 2) + "\n",
  )

  console.log(summary(report))
  console.log("index: .rule-ids/index.json")
  if (report.failures.length > 0) {
    console.error(
      `\n${report.failures.length} failures:\n${report.failures.map((failure) => `  ${failure}`).join("\n")}`,
    )
    process.exitCode = 1
  }
}

const main = () => {
  const parsed = command(process.argv.slice(2))
  if (parsed.mode === "check") return check()
  if (parsed.mode === "list")
    return console.log(list(readParts(), parsed.slice).join("\n"))
  const shown = show(readParts(), parsed.id, parsed.section)
  if (shown === undefined) {
    console.error(`${parsed.id} is not a rule id of the spec`)
    process.exitCode = 1
  } else console.log(shown)
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
