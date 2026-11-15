// The second local command of docs/spec/17-testing.md. It runs the image layer on Docker, or on podman when Docker
// is not installed. `CHAD_ENGINE` names the engine when both are.
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The container engines the image layer runs on, in the order they are tried. */
export const engines = ["docker", "podman"]

/** The first engine of the list that `installed` finds, unless `named` picks one. */
export const pick = (
  named: string | undefined,
  installed: (engine: string) => boolean,
) => named ?? engines.find(installed)

const main = () => {
  const engine = pick(
    process.env["CHAD_ENGINE"],
    (engine) =>
      spawnSync(engine, ["--version"], { stdio: "ignore" }).status === 0,
  )
  if (engine === undefined) {
    console.error(`missing tools: ${engines.join(" or ")}`)
    return 1
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const vitest = spawnSync(
    process.execPath,
    [join(root, "node_modules/vitest/vitest.mjs"), "run", "--project", "image"],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CHAD_ENGINE: engine },
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
