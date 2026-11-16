import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { layers as localLayers } from "../../scripts/local.ts"
import { parseDelivered, parseSpec } from "../../scripts/rule-ids.ts"
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
  it("LOAD-1 the builder and CI run the code and the tests on Node 26", () => {
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

  it("OV-16 the package runs on Node 26 and no other major", () => {
    expect(pkg.engines.node).toBe("^26.0.0")
  })
})

describe("the pinned packages", () => {
  it("IMG-52 OV-52 every effect package is a tarball under vendor/ through the catalog, and a manifest names the commit in full", () => {
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

  it("IMG-133 OV-51 the snapshot is the effect-chat branch at e1ae842 or at a later commit", () => {
    // The floor's commit date, from the effect repository.
    const floor = Date.parse("2026-11-14T21:49:08Z")
    expect(manifest.branch).toBe("effect-chat")
    expect(
      manifest.commit.startsWith("e1ae842") ||
        Date.parse(manifest.commitDate) > floor,
    ).toBe(true)
  })

  it("IMG-134 OV-53 the effect packages are all vendored tarballs, or all released versions with no vendor/", () => {
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

  it("IMG-54 the pnpm 12 workspace carries the four settings the install needs", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@12\./)
    expect(workspace.blockExoticSubdeps).toBe(false)
    expect(workspace.enableGlobalVirtualStore).toBe(false)
    expect(workspace.allowBuilds).toEqual({ esbuild: true })
    expect(workspace.minimumReleaseAgeExclude).toEqual(["clanka@0.28.0"])
  })

  it("IMG-55 OV-17 clanka is 0.28.0 from npm, pinned by the lockfile and not vendored", () => {
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
  it("TST-133 one command runs layers 1 to 4 on a developer's machine", () => {
    expect(pkg.scripts.test).toBe("node scripts/local.ts")
    expect(localLayers).toEqual(["types", "unit", "daemon", "process"])
  })
})

describe("the spec in the repository", () => {
  const parts = readdirSync(path("docs/spec")).filter((file) =>
    /^\d\d-/.test(file),
  )

  it("OV-54 lives under docs/spec/, one file for each part the overview lists", () => {
    const listed = [
      ...read("docs/spec/00-overview.md").matchAll(
        /^\| (\d\d-[a-z-]+\.md) \|/gm,
      ),
    ].map((match) => match[1])
    expect(listed).toHaveLength(21)
    expect(parts.toSorted()).toEqual(listed.toSorted())
  })

  it("OV-55 AGENTS.md at the root holds the builder's contract", () => {
    const contract = read("AGENTS.md")
    expect(contract).toContain("This file is the builder's contract.")
    expect(contract).toContain("## Binding rules and defaults")
  })

  it("ORD-9 the delivered file lists the delivered slices in build order", () => {
    const order = parseSpec({
      "19-build-order.md": read("docs/spec/19-build-order.md"),
    }).slices.map((slice) => slice.name)
    const delivered = parseDelivered(read("docs/spec/delivered.md")).slices
    expect(order).toHaveLength(20)
    expect(delivered[0]).toBe("repo")
    expect(delivered).toEqual(order.slice(0, delivered.length))
  })
})
