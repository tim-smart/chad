// Builds the package into dist before any test runs. Layers 3 and 4 import the built package, never chad's source.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export default () => {
  const root = fileURLToPath(new URL("../..", import.meta.url))
  const build = spawnSync(
    process.execPath,
    [root + "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
    { cwd: root, stdio: "inherit" },
  )
  if (build.status !== 0) throw new Error("the build of dist failed")
}
