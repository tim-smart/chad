// The local command of docs/spec/17-testing.md. It checks for the tools the scenarios call,
// names the ones that are missing, and then runs layers 1 to 4.
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The tools a test starts as a process. */
export const tools = ["git", "pnpm"]

/** The vitest projects of layers 1 to 4. The image layer has its own command. */
export const layers = ["types", "unit", "daemon", "process"]

const main = () => {
  const missing = tools.filter(
    (tool) =>
      spawnSync(tool, ["--version"], { stdio: "ignore" }).error !== undefined,
  )
  if (missing.length > 0) {
    console.error(`missing tools: ${missing.join(", ")}`)
    return 1
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const projects = layers.flatMap((layer) => ["--project", layer])
  const vitest = spawnSync(
    process.execPath,
    [join(root, "node_modules/vitest/vitest.mjs"), "run", ...projects],
    {
      cwd: root,
      stdio: "inherit",
    },
  )
  return vitest.status ?? 1
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main()
}
