import { spawnSync } from "node:child_process"
import { path } from "../support/repo.ts"

/** Runs the type-check over one fixture directory under test/types/fixtures. */
export const tsc = (fixture: string) => {
  const result = spawnSync(
    process.execPath,
    [
      path("node_modules/typescript/bin/tsc"),
      "--noEmit",
      "-p",
      path(`test/types/fixtures/${fixture}`),
    ],
    { encoding: "utf8" },
  )
  return { status: result.status, output: result.stdout + result.stderr }
}
