import { expect, it } from "vitest"
import { yaml } from "../support/repo.ts"
import { tsc } from "./tsc.ts"

it("OV-14 clanka is used as published, and its McpServers.layer is built from the config alone", () => {
  expect(tsc("clanka")).toEqual({ status: 0, output: "" })
  const workspace = yaml("pnpm-workspace.yaml")
  expect(workspace.patchedDependencies).toBeUndefined()
  expect(Object.keys(workspace.overrides)).not.toContain("clanka")
})
