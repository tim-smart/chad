// An install cut by a kill, in layer 4: the daemon as a child process, killed while npm is fetching a package for an
// apply, and started again on the same volume.
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { write } from "../support/applied.ts"
import { daemon } from "../support/process.ts"
import * as Registry from "../support/registry.ts"

test("a kill during an install leaves no install under the lockfile's hash, nothing is committed, and the next apply installs it whole and deletes what the cut one left", async () => {
  const registry = await Registry.start()
  const running = await daemon()
  const first = await running.start()
  const repo = join(running.data, "repo")
  const work = join(repo, "work")
  write(work, {
    "package.json": JSON.stringify({
      type: "module",
      private: true,
      dependencies: { greet: "1.0.0" },
    }),
    "plugins/hello.ts":
      'import { Layer } from "effect"\nimport { Plugin } from "chad"\nimport { greet } from "greet"\n\nexport default Plugin.make(Layer.effectDiscard(greet("Tim")))\n',
  })
  await registry.lock(work)
  const hold = registry.hold("greet")
  const cut = running.chad(["apply", "-m", "Add hello"])
  await hold.held
  const packages = join(repo, "packages")
  const partial = readdirSync(packages)
  expect(partial).toHaveLength(1)
  expect(partial[0]).toMatch(/^\.install-/)
  expect((await first.kill()).signal).toBe("SIGKILL")
  expect((await cut).code).not.toBe(0)
  hold.release()

  await running.start()
  const log = await running.chad(["log", "--json"])
  expect(JSON.parse(log.stdout)).toHaveLength(1)
  const applied = await running.chad(["apply", "-m", "Add hello"])
  expect(applied.code, applied.stderr).toBe(0)
  expect(applied.stdout).toContain("Packages added: greet 1.0.0, words 1.0.0.")
  const [install, ...others] = readdirSync(packages)
  expect(others).toEqual([])
  expect(install).toMatch(/^[0-9a-f]{16}$/)
  expect(
    existsSync(join(packages, install!, "node_modules", "greet", "index.js")),
  ).toBe(true)
  expect((await running.chad(["status"])).stdout).toContain("plugin: hello")
})
