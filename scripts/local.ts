// The local test command, `pnpm test`. It checks for the tools the scenarios call,
// names the ones that are missing, checks Node against the Dockerfile, and then runs layers 1 to 4.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The tools a test starts as a process. */
export const tools = ["git", "pnpm"]

/** The vitest projects of layers 1 to 4. The image layer has its own command. */
export const layers = ["types", "unit", "daemon", "process"]

/** The major version of Node that the Dockerfile's base image names. The Dockerfile is the source of that version. */
export const dockerfileNode = (dockerfile: string) => {
  const major = /^ARG NODE=\S*\/node:(\d+)/m.exec(dockerfile)?.[1]
  if (major === undefined) {
    throw new Error("the Dockerfile names no Node version")
  }
  return major
}

/** What is wrong with the running Node, when its major version is not the Dockerfile's. */
export const nodeProblem = (dockerfile: string, running: string) => {
  const wanted = dockerfileNode(dockerfile)
  const major = running.replace(/^v/, "").split(".")[0]
  return major === wanted
    ? undefined
    : `Node ${running} is running and the Dockerfile names Node ${wanted}`
}

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
  const problem = nodeProblem(
    readFileSync(join(root, "Dockerfile"), "utf8"),
    process.version,
  )
  if (problem !== undefined) {
    console.error(problem)
    return 1
  }
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
