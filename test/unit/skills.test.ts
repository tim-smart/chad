import { expect, test } from "vitest"
import * as Skills from "../support/skills.ts"

const text = (name: string) =>
  Skills.files().find((file) => file.name === name)!.text

// Regressions for two checks that passed a broken skill: a quote whose fixed text a template's variable part absorbed,
// and a path whose mistyped root dropped it from the check.
test("a quote that differs from chad's message by one word is refused, and a path under an unknown root is still checked", () => {
  const skill = text("self-edit/SKILL.md")
  expect(Skills.unquotable(skill)).toEqual([])
  expect(
    Skills.unquotable(skill.replace("in your next turn.", "in your banana.")),
  ).toEqual([
    "<tool> was changed by an apply. The new version is in your banana.",
  ])

  const declarations = "/data/repo/node_modules/chad/dist/Session.d.ts"
  const typo = "/dtaa/repo/node_modules/chad/dist/Session.d.ts"
  const plugin = text("self-edit/plugin.md")
  expect(Skills.paths(plugin)).toContain(declarations)
  expect(Skills.paths(plugin.replace(declarations, typo))).toContain(typo)
})
