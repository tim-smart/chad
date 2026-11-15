import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { path } from "../support/repo.ts"

it("TST-134 the local command names the tools that are missing before it runs a layer", () => {
  const empty = mkdtempSync(join(tmpdir(), "chad-path-"))
  try {
    const local = spawnSync(process.execPath, [path("scripts/local.ts")], {
      env: { PATH: empty },
      encoding: "utf8",
    })
    expect(local).toMatchObject({
      status: 1,
      stdout: "",
      stderr: "missing tools: git, pnpm\n",
    })
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
