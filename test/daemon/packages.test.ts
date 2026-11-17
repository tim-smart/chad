// A plugin's own npm packages: work/package.json and its lockfile, installed by chad from a registry stand-in, bundled
// into the plugin with the host's effect, and loaded again by a boot that has no network. An install that would bring
// an effect the host does not satisfy is refused.
import { existsSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { git, write } from "../support/applied.ts"
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

test("a check refuses a package that needs another effect and an alias of effect, an apply leaves out a node_modules the agent made, installs the packages work/package.json names and the plugin's tool runs them on the host's effect, a boot with the install and the registry gone installs them again from chad's cache, and a revert takes them away", async () => {
  const registry = await Registry.start()
  const running = await scenario({ env })
  await running.logged("boot.ready")
  const repo = join(running.data, "repo")
  const work = join(repo, "work")
  // A package that needs an effect the host's does not satisfy is refused, and so are an npm alias of effect, whether
  // it keeps effect's name or takes another, and another package aliased under a host package's name, whose types
  // would shadow the host's copy that the bundle runs. Nothing is installed.
  write(work, {
    "package.json": manifest({
      legacy: "1.0.0",
      effect: "npm:effect@^3.0.0",
      fx: "npm:effect@^4.0.0",
      semver: "npm:words@1.0.0",
    }),
  })
  await registry.lock(work)
  const refused = await running.chad(["check"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("legacy@1.0.0 needs effect ^3.0.0")
  expect(refused.stderr).toContain("work/package.json needs effect ^3.0.0")
  expect(refused.stderr).toContain(
    'work/package.json asks for fx as "npm:effect@^4.0.0"',
  )
  expect(refused.stderr).toContain(
    'work/package.json asks for semver as "npm:words@1.0.0"',
  )
  expect(existsSync(join(repo, "packages"))).toBe(false)

  // A node_modules the agent made, here a link to a greet of its own beside the plugin, is never applied or loaded.
  const own = join(running.directory, "own")
  write(join(own, "greet"), {
    "package.json": JSON.stringify({ name: "greet", main: "index.js" }),
    "index.js": 'throw new Error("the agent\'s own greet was loaded")\n',
  })
  write(work, {
    "package.json": manifest({ greet: "1.0.0" }),
    "plugins/hello.ts": hello,
  })
  symlinkSync(own, join(work, "plugins", "node_modules"))
  await registry.lock(work)
  const applied = await running.chad(["apply", "-m", "Add hello"])
  expect(applied.code, applied.stderr).toBe(0)
  expect(applied.stdout).toContain("Packages added: greet 1.0.0, words 1.0.0.")
  // The fake effect of the registry throws when it runs, so the tool answers only on the host's.
  expect(await greeted(running, "direct", "greet Tim")).toContain(
    "hello from words, Tim",
  )
  expect(git(work, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(
    "node_modules",
  )
  expect((await running.chad(["status"])).stdout).toContain(
    "work: no changes since the applied commit",
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
