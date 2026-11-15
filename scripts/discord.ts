// The nightly Discord job of docs/spec/17-testing.md, as one command. It runs the `discord` project, which is chad's
// test bot on the real gateway with a second bot driving it. Without its secrets it fails and names them, and it
// never passes or leaves a test out.
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The repository secrets the job reads: the token of chad's test bot, and the token of the second bot. */
export const secrets = ["DISCORD_CHAD_TOKEN", "DISCORD_DRIVER_TOKEN"] as const

/** The secrets the environment lacks. GitHub gives a job an empty string for a secret that is not set. */
export const missing = (env: NodeJS.ProcessEnv): ReadonlyArray<string> =>
  secrets.filter((name) => (env[name] ?? "") === "")

const main = () => {
  const lacking = missing(process.env)
  if (lacking.length > 0) {
    console.error(`missing secrets: ${lacking.join(", ")}`)
    return 1
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const vitest = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--project",
      "discord",
    ],
    { cwd: root, stdio: "inherit" },
  )
  return vitest.status ?? 1
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main()
}
