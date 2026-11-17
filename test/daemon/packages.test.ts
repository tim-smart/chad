// A plugin's own npm packages: work/package.json and its lockfile, installed by chad from a registry stand-in, bundled
// into the plugin with the host's effect, loaded again by a boot that has no network, and an install that would bring
// an effect the host does not satisfy.
import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { write } from "../support/applied.ts"
import { scenario, type Scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { eventually, says } from "../support/owner.ts"
import * as Registry from "../support/registry.ts"

/** A plugin whose tool `greet` answers with the `greet` package, which imports effect and the `words` package. */
const hello = `import { Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Plugin } from "chad"
import { greet } from "greet"

const Greet = Tool.make("greet", {
  description: "Greets someone.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
})
const Hello = Toolkit.make(Greet)

export default Plugin.make(
  Plugin.toolkit(Hello).pipe(
    Layer.provide(Hello.toLayer({ greet: ({ name }) => greet(name) })),
  ),
)
`

/** No npm cache of the owner's, so an install uses `cache/npm` on the volume, as the image's does. */
const env = { NPM_CONFIG_CACHE: undefined, npm_config_cache: undefined }

const manifest = (dependencies: Record<string, string>) =>
  JSON.stringify({ type: "module", private: true, dependencies }, null, 2)

/**
 * Runs one turn whose script calls `greet`, and gives what the script printed. A restarted scenario's platform gives
 * out the same ids again, so the turn after a restart takes the other kind of thread.
 */
const greeted = async (
  running: Scenario,
  kind: "direct" | "thread",
  text: string,
) => {
  const ended = () =>
    running.log().filter((line) => line.annotations["event"] === "turn.ended")
      .length
  const before = ended()
  await running.fakes.model.script([
    runs('console.log(await greet({ name: "Tim" }))'),
    { text: "done" },
  ])
  await says(running, await running.fakes.chat.makeThread(kind), text, {
    mention: kind === "thread",
  })
  await eventually(ended, (count) => count > before)
  return results((await running.fakes.model.calls()).at(-1)).join("\n")
}

test("an apply installs the packages work/package.json names and the plugin's tool runs them on the host's effect, a boot with the install and the registry gone installs them again from chad's cache, and a revert takes them away", async () => {
  const registry = await Registry.start()
  const running = await scenario({ env })
  await running.logged("boot.ready")
  const repo = join(running.data, "repo")
  const work = join(repo, "work")
  write(work, {
    "package.json": manifest({ greet: "1.0.0" }),
    "plugins/hello.ts": hello,
  })
  await registry.lock(work)
  const applied = await running.chad(["apply", "-m", "Add hello"])
  expect(applied.code, applied.stderr).toBe(0)
  expect(applied.stdout).toContain("Packages added: greet 1.0.0, words 1.0.0.")
  // The fake effect of the registry throws when it runs, so the tool answers only on the host's.
  expect(await greeted(running, "direct", "greet Tim")).toContain(
    "hello from words, Tim",
  )
  const [install, ...others] = readdirSync(join(repo, "packages"))
  expect(others).toEqual([])
  const modules = join(repo, "packages", install!, "node_modules")
  expect(existsSync(join(modules, "greet"))).toBe(true)
  expect(existsSync(join(modules, "effect"))).toBe(false)
  expect(existsSync(join(modules, "greet", "postinstall-ran"))).toBe(false)

  await registry.close()
  expect(await running.stop()).toBe(0)
  rmSync(join(repo, "packages"), { recursive: true })
  expect(
    readdirSync(join(running.data, "cache", "npm")).length,
  ).toBeGreaterThan(0)
  const again = await scenario({ directory: running.directory, env })
  // The log holds the first boot's lines too.
  await eventually(
    () =>
      again.log().filter((line) => line.annotations["event"] === "boot.ready"),
    (readies) => readies.length === 2,
  )
  expect(await greeted(again, "thread", "greet Tim again")).toContain(
    "hello from words, Tim",
  )

  const reverted = await again.chad(["revert"])
  expect(reverted.code, reverted.stderr).toBe(0)
  expect(reverted.stdout).toContain(
    "Packages removed: greet 1.0.0, words 1.0.0.",
  )
  expect(readdirSync(join(repo, "packages"))).toEqual([])
})

test("a check refuses a package that needs an effect the host's does not satisfy, and names it", async () => {
  const registry = await Registry.start()
  const running = await scenario()
  await running.logged("boot.ready")
  const work = join(running.data, "repo", "work")
  write(work, { "package.json": manifest({ legacy: "1.0.0" }) })
  await registry.lock(work)
  const checked = await running.chad(["check"])
  expect(checked.code).toBe(1)
  expect(checked.stderr).toContain("legacy@1.0.0 needs effect ^3.0.0")
  expect(existsSync(join(running.data, "repo", "packages"))).toBe(false)
})
