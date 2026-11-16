// The check of an exported tree that an apply and `chad check` run before any Layer is built (LOAD-53).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { expect, it } from "vitest"
import * as Loader from "../../src/daemon/Loader.ts"
import * as RepoLinks from "../../src/daemon/RepoLinks.ts"

const check = (files: Record<string, string>) => {
  const repo = mkdtempSync(join(tmpdir(), "chad-loader-"))
  const tree = join(repo, "versions", "t1")
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, file)), { recursive: true })
    writeFileSync(join(tree, file), text)
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* RepoLinks.prepare(repo)
      return { repo, errors: yield* Loader.check(repo, tree) }
    }).pipe(Effect.provide(NodeServices.layer)),
  )
}

const plugin = `import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { Plugin } from "chad"
import { label } from "./ticker/label.ts"

export default Plugin.make(
  Plugin.prompt(() => Effect.sync(() => label + typeof readFileSync)),
)
`

it("LOAD-22 LOAD-25 LOAD-27 LOAD-29 LOAD-30 LOAD-31 LOAD-53 LOAD-76 a tree that type-checks passes, and a type error and a missing package fail the check with work/ paths and what to do", async () => {
  const passed = await check({
    "plugins/clock.ts": plugin,
    "plugins/ticker/label.ts": 'export const label = "tick"\n',
    // A TypeScript file outside plugins/ is not checked (LOAD-81).
    "skills/tool/run.ts": "const n: number = 'x'\n",
  })
  expect(passed.errors).toEqual([])

  const failed = await check({
    "plugins/clock.ts": plugin.replace(
      'import { Plugin } from "chad"',
      'import { Plugin } from "chad"\nimport pad from "left-pad"\nconst n: number = "x"',
    ),
    "plugins/ticker/label.ts": 'export const label = "tick"\n',
  })
  expect(failed.errors).toHaveLength(1)
  expect(failed.errors[0]!.split("\n")).toEqual([
    "work/plugins/clock.ts(4,17): error TS2307: Cannot find module 'left-pad'. A plugin has no packages of its own. It can import chad, effect and Node's built-in modules, such as node:fs.",
    "work/plugins/clock.ts(5,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    `Read ${failed.repo}/node_modules/effect/AGENTS.md before you write Effect code.`,
  ])
})
