// The check of an exported tree that an apply and `chad check` run before any Layer is built (LOAD-53).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { expect, it, vi } from "vitest"
import * as Messages from "../../src/Messages.ts"
import * as Loader from "../../src/daemon/Loader.ts"
import * as RepoLinks from "../../src/daemon/RepoLinks.ts"

/** A repo with the links of a boot and one exported tree of the given files. */
const repoWith = async (files: Record<string, string>) => {
  const repo = mkdtempSync(join(tmpdir(), "chad-loader-"))
  const tree = join(repo, "versions", "t1")
  mkdirSync(tree, { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, file)), { recursive: true })
    writeFileSync(join(tree, file), text)
  }
  await provided(RepoLinks.prepare(repo))
  return { repo, tree }
}

const provided = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const check = async (files: Record<string, string>) => {
  const { repo, tree } = await repoWith(files)
  return { repo, errors: await provided(Loader.check(repo, tree)) }
}

const empty = `import { Layer } from "effect"
import { Plugin } from "chad"

export default Plugin.make(Layer.empty)
`

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

it("LOAD-5 LOAD-17 LOAD-25 LOAD-9 LOAD-29 REC-42 a dangling link skips only its plugin, a bundled name never runs, a tree with no plugin passes, an import() of a package runs, and the tree's tsconfig moves no package", async () => {
  const marker = join(tmpdir(), `chad-loader-ran-${process.pid}`)
  rmSync(marker, { force: true })
  const { repo, tree } = await repoWith({
    "plugins/good.ts": empty,
    "plugins/same.ts": `import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(marker)}, "ran")
`,
    "plugins/dynamic.ts": `import { Effect, Layer } from "effect"
import { Plugin } from "chad"

export default Plugin.make(
  Layer.effectDiscard(Effect.promise(() => import("effect"))),
)
`,
    "plugins/aliased.ts": empty,
    "plugins/lib/fake.ts": 'throw new Error("the wrong effect")\n',
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { effect: ["./plugins/lib/fake.ts"] } },
    }),
  })
  symlinkSync("./missing.ts", join(tree, "plugins", "broken.ts"))
  const { loaded, skipped } = await provided(
    Loader.load(tree, new Set(["same"])),
  )
  expect(loaded.map(({ name }) => name)).toEqual(["aliased", "dynamic", "good"])
  expect(skipped.map(({ name }) => name)).toEqual(["same", "broken"])
  expect(skipped[0]!.message).toBe(Messages.bundledName("same"))
  expect(existsSync(marker)).toBe(false)
  const dynamic = loaded.find(({ name }) => name === "dynamic")!
  await provided(
    Effect.scoped(
      Layer.build(
        // The plugin asks for no service of the API, so it builds with none.
        dynamic.plugin as unknown as Layer.Layer<never>,
      ),
    ),
  )

  const none = await repoWith({ "skills/tool/run.ts": "export {}\n" })
  expect(await provided(Loader.check(none.repo, none.tree))).toEqual([])
  expect(repo).not.toBe(none.repo)
})

it("IMG-46 IMG-143 a move aside never replaces what an earlier one kept, in the same millisecond", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chad-repolinks-"))
  const path = join(repo, "node_modules")
  const saved = `${path}.replaced-2026-11-16T06-28-57-056Z`
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-16T06:28:57.056Z"))
  try {
    for (const text of ["first", "second", "third"]) {
      rmSync(path, { force: true })
      writeFileSync(path, text)
      await provided(RepoLinks.prepare(repo))
    }
  } finally {
    vi.useRealTimers()
  }
  expect(
    [saved, `${saved}-1`, `${saved}-2`].map((file) =>
      readFileSync(file, "utf8"),
    ),
  ).toEqual(["first", "second", "third"])
})

it("IMG-143 a move aside never replaces a link to nothing at its name", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chad-repolinks-"))
  const path = join(repo, "node_modules")
  const saved = `${path}.replaced-2026-11-16T06-28-57-056Z`
  symlinkSync("./missing", saved)
  writeFileSync(path, "owner")
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-16T06:28:57.056Z"))
  try {
    await provided(RepoLinks.prepare(repo))
  } finally {
    vi.useRealTimers()
  }
  expect(readlinkSync(saved)).toBe("./missing")
  expect(readFileSync(`${saved}-1`, "utf8")).toBe("owner")
})

it("REC-48 LOAD-99 LOAD-16 LOAD-17 a plugins that is a file loads nothing and fails nothing, and an import() of a package gets the host's instance where the tree has its own", async () => {
  const file = await repoWith({ plugins: "not a directory" })
  expect(await provided(Loader.load(file.tree))).toEqual({
    loaded: [],
    skipped: [],
  })

  const { tree } = await repoWith({
    "node_modules/effect/package.json": JSON.stringify({
      name: "effect",
      type: "module",
      exports: "./index.mjs",
    }),
    "node_modules/effect/index.mjs": "export const shadow = true\n",
    "plugins/dynamic.ts": `import { Effect, Layer } from "effect"
import { Plugin } from "chad"

export default Plugin.make(
  Layer.effectDiscard(
    Effect.promise(async () => {
      const dynamic = await import("effect")
      ;(globalThis as Record<string, unknown>)["chadDynamic"] =
        dynamic.Effect === Effect
    }),
  ),
)
`,
  })
  const { loaded, skipped } = await provided(Loader.load(tree))
  expect(skipped).toEqual([])
  await provided(
    Effect.scoped(
      Layer.build(
        // The plugin asks for no service of the API, so it builds with none.
        loaded[0]!.plugin as unknown as Layer.Layer<never>,
      ),
    ),
  )
  expect((globalThis as Record<string, unknown>)["chadDynamic"]).toBe(true)
})
