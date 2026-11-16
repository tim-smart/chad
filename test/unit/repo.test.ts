import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { layers as localLayers } from "../../scripts/local.ts"
import { exists, json, lockfile, path, read, yaml } from "../support/repo.ts"

const pkg = json("package.json")
const workspace = yaml("pnpm-workspace.yaml")
const lock = lockfile()
const gate = yaml(".github/workflows/gate.yml")
const manifest = json("vendor/manifest.json")

const effectPackages = (names: ReadonlyArray<string>) =>
  names.filter((name) => name === "effect" || name.startsWith("@effect/"))
const dependencies: Record<string, string> = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
}
const catalog: Record<string, string> = workspace.catalog
const locked = Object.keys(lock.packages)

describe("the toolchain", () => {
  it("the development shell and CI run the code and the tests on Node 26", () => {
    expect(process.versions.node.split(".")[0]).toBe("26")
    expect(read("flake.nix")).toContain("nodejs_26")
    for (const job of Object.values<{
      steps: ReadonlyArray<{ uses?: string; with?: Record<string, unknown> }>
    }>(gate.jobs)) {
      const node = job.steps.find((step) =>
        step.uses?.startsWith("actions/setup-node@"),
      )
      expect(node?.with?.["node-version"]).toBe(26)
    }
  })

  it("the package runs on Node 26 and no other major", () => {
    expect(pkg.engines.node).toBe("^26.0.0")
  })
})

describe("the pinned packages", () => {
  it("every effect package is a tarball under vendor/ through the catalog, and a manifest names the commit in full", () => {
    const direct = effectPackages(Object.keys(dependencies))
    expect(direct).toEqual(
      expect.arrayContaining([
        "effect",
        "@effect/ai-openai",
        "@effect/ai-openai-compat",
      ]),
    )
    for (const name of direct) expect(dependencies[name]).toBe("catalog:")
    for (const [name, target] of Object.entries(catalog)) {
      expect(effectPackages([name])).toEqual([name])
      expect(target).toMatch(/^file:vendor\/[a-z-]+\.tgz$/)
      expect(exists(target.slice("file:".length))).toBe(true)
    }
    for (const name of effectPackages(locked))
      expect(name).toContain("@file:vendor/")
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("the snapshot is the effect-chat branch at e1ae842 or at a later commit", () => {
    // The floor's commit date, from the effect repository.
    const floor = Date.parse("2026-11-14T21:49:08Z")
    expect(manifest.branch).toBe("effect-chat")
    expect(
      manifest.commit.startsWith("e1ae842") ||
        Date.parse(manifest.commitDate) > floor,
    ).toBe(true)
  })

  it("the effect packages are all vendored tarballs, or all released versions with no vendor/", () => {
    const targets = Object.values(catalog)
    if (exists("vendor")) {
      expect(targets.every((target) => target.startsWith("file:vendor/"))).toBe(
        true,
      )
      expect(exists("vendor/manifest.json")).toBe(true)
    } else {
      expect(targets.every((target) => /^\d+\.\d+\.\d+$/.test(target))).toBe(
        true,
      )
    }
  })

  it("the pnpm 12 workspace carries the four settings the install needs", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@12\./)
    expect(workspace.blockExoticSubdeps).toBe(false)
    expect(workspace.enableGlobalVirtualStore).toBe(false)
    expect(workspace.allowBuilds).toEqual({ esbuild: true })
    expect(workspace.minimumReleaseAgeExclude).toEqual(["clanka@0.28.0"])
  })

  it("clanka is 0.28.0 from npm, pinned by the lockfile and not vendored", () => {
    expect(pkg.dependencies.clanka).toBe("0.28.0")
    expect(lock.packages["clanka@0.28.0"].resolution).toEqual({
      integrity: expect.stringMatching(/^sha512-/),
    })
    expect(locked.filter((name) => name.startsWith("clanka@"))).toEqual([
      "clanka@0.28.0",
    ])
    expect(
      readdirSync(path("vendor")).filter((file) => file.includes("clanka")),
    ).toEqual([])
  })
})

describe("continuous integration", () => {
  it("one command runs layers 1 to 4 on a developer's machine", () => {
    expect(pkg.scripts.test).toBe("node scripts/local.ts")
    expect(localLayers).toEqual(["types", "unit", "daemon", "process"])
  })
})
