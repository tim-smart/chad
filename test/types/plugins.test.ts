// The type layer of a plugin: the compiler options `chad check` uses, run over the asphodel fixture and over the two
// deliberate mistakes, each of which must fail with its own error and name the service or type it lacks.
import { spawnSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { expect, it } from "vitest"
import { compilerOptions } from "../../dist/daemon/Loader.js"
import { path } from "../support/repo.ts"

/** Each mistake's file, the error code it fails with, and the service or type its error names. */
const mistakes = {
  "tool-dependency": ["TS2345", "Notes | PluginContext"],
  "hook-wrong-type": ["TS2322", "Effect<string"],
} as const

it("the fixture plugin passes the check's options, and each of the two mistakes fails with its code and names what is missing", () => {
  // The config sits in the package, so the Node types resolve from its node_modules as they do from repo/.
  const config = path(
    `test/types/fixtures/plugins-${process.pid}.tsconfig.json`,
  )
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions,
      include: ["mistakes/*.ts", "../../fixtures/asphodel/asphodel.ts"],
    }),
  )
  try {
    const result = spawnSync(
      process.execPath,
      [
        path("node_modules/typescript/bin/tsc"),
        "-p",
        config,
        "--pretty",
        "false",
      ],
      { encoding: "utf8" },
    )
    const errors = (result.stdout + result.stderr)
      .split("\n")
      .filter((line) => line.startsWith("test/"))
    expect(errors.filter((line) => !line.includes("/mistakes/"))).toEqual([])
    for (const [name, [code, named]] of Object.entries(mistakes)) {
      const own = errors.filter((line) =>
        line.startsWith(`test/types/fixtures/mistakes/${name}.ts(`),
      )
      expect(own, name).toHaveLength(1)
      expect(own[0], name).toContain(`error ${code}:`)
      expect(own[0], name).toContain(named)
    }
  } finally {
    rmSync(config)
  }
})
