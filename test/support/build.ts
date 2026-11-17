// Builds the package into dist before any test runs. Layers 3 and 4 import the built package, never chad's source.
// It runs the steps of the package's own `build` script: chad's modules as separate files, then the daemon's and the
// client's bundles.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export default () => {
  const root = fileURLToPath(new URL("../..", import.meta.url))
  const script: string = JSON.parse(readFileSync(root + "package.json", "utf8"))
    .scripts.build
  for (const step of script.split(" && ")) {
    const ran = spawnSync(step, {
      cwd: root,
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        PATH: `${root}node_modules/.bin:${process.env["PATH"] ?? ""}`,
      },
    })
    if (ran.status !== 0) throw new Error(`the build of dist failed at ${step}`)
  }
}
