// Plugins loaded from the applied tree at boot: the bundle and its run, the host's own packages, the work/ paths in an
// error, the plugins that are skipped, and the links under repo/.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { Data, Deferred, Effect, Layer } from "effect"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import sendFile from "../../dist/plugins/send-file.js"
import { fresh, scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { path } from "../support/repo.ts"
import { applied } from "../support/applied.ts"
import { rows, says } from "../support/owner.ts"

class NoBuild extends Data.TaggedError("NoBuild") {}

const dice = `import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Plugin } from "chad"
import { explode } from "./lib/explode.ts"
import { faces } from "./lib/faces.ts"

const Roll = Tool.make("roll", {
  description: "Rolls a die.",
  parameters: Schema.Struct({}),
  success: Schema.String,
})
const Burst = Tool.make("burst", {
  description: "Bursts the die.",
  parameters: Schema.Struct({}),
  success: Schema.String,
})
const Dice = Toolkit.make(Roll, Burst)

export default Plugin.make(
  Plugin.toolkit(Dice).pipe(
    Layer.provide(
      Dice.toLayer({
        roll: () => Effect.succeed(\`faces \${faces.join(",")}\`),
        burst: () => Effect.sync(() => explode()),
      }),
    ),
  ),
)
`

test("a boot loads the applied tree's plugins with the host's packages, gives work/ paths in a load error and a tool error, skips what cannot load, and keeps what it found at repo/node_modules", async () => {
  const directory = fresh()
  const repo = join(directory, "data", "repo")
  applied(repo, {
    "plugins/dice.ts": dice,
    "plugins/lib/faces.ts": "export const faces = [1, 2, 3, 4, 5, 6]\n",
    "plugins/lib/explode.ts":
      'export const explode = (): string => {\n  throw new Error("the die burst")\n}\n',
    "plugins/ticker/index.ts": `import { Effect } from "effect"
import * as Plugin from "chad/Plugin"
import { label } from "./label.ts"

export default Plugin.make(Plugin.prompt(() => Effect.succeed(label)))
`,
    "plugins/ticker/label.ts": 'export const label = "ticker chunk text"\n',
    "plugins/broken.ts": `import { Layer } from "effect"
import { Plugin } from "chad"
import { connect } from "./lib/connect.ts"

connect()
export default Plugin.make(Layer.empty)
`,
    "plugins/lib/connect.ts":
      'export const connect = () => {\n  throw new Error("no server")\n}\n',
    "plugins/send-file.ts": `import { Layer } from "effect"
import { Plugin } from "chad"

export default Plugin.make(Layer.empty)
`,
  })
  // What the owner left at the two links' paths: a directory is moved aside whole, and a link is replaced.
  mkdirSync(join(repo, "node_modules"))
  writeFileSync(join(repo, "node_modules", "keep.txt"), "kept")
  symlinkSync("/nowhere", join(repo, "examples"))

  const running = await scenario({
    directory,
    plugins: [{ name: "send-file", plugin: sendFile }],
  })
  const { fakes } = running
  const broken = await running.logged(
    "plugin.skipped",
    (line) => line.annotations["plugin"] === "broken",
  )
  expect(String(broken.annotations["error"])).toContain(
    "at connect (work/plugins/lib/connect.ts:2:9)",
  )
  const shadow = await running.logged(
    "plugin.skipped",
    (line) => line.annotations["plugin"] === "send-file",
  )
  expect(shadow.annotations["reason"]).toBe(Messages.bundledName("send-file"))

  await fakes.model.script([
    runs("console.log(await roll({}))\nconsole.log(await burst({}))"),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "roll")
  // The direct message gets the notice of the skipped plugins too, so the turn's end is what is waited for.
  await running.logged("turn.ended")
  const [first, second] = await fakes.model.calls()
  expect(JSON.stringify(first?.body)).toContain("ticker chunk text")
  const output = results(second).join("\n")
  expect(output).toContain("faces 1,2,3,4,5,6")
  expect(output).toContain("work/plugins/lib/explode.ts:2:9")

  // The notice goes to the direct message in which the owner's latest message arrived.
  const notice = await running.logged(
    "notice.sent",
    (line) => line.annotations["key"] === "plugin-skipped:broken",
  )
  expect(notice.annotations["thread"]).toBe(`local:${thread.id}`)
  const status = (await running.chad(["status"])).stdout
  expect(status).toContain("plugin: dice, 0 warnings")
  expect(status).toContain("plugin: ticker, 0 warnings")
  expect(status).toContain(
    `plugin: broken, skipped (${Messages.notLoaded("broken", "Error: no server")})`,
  )
  expect(
    rows(running, "SELECT key FROM notices WHERE holds = 1 ORDER BY key").map(
      (row) => row["key"],
    ),
  ).toEqual(["plugin-skipped:broken", "plugin-skipped:send-file"])

  expect(readlinkSync(join(repo, "node_modules"))).toBe(path("node_modules"))
  expect(readlinkSync(join(repo, "examples"))).toBe(path("plugins"))
  expect(existsSync(join(repo, "examples", "send-file.ts"))).toBe(true)
  expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8"))).toEqual({
    type: "module",
  })
  const moved = readdirSync(repo).filter((name) =>
    name.startsWith("node_modules.replaced-"),
  )
  expect(moved).toHaveLength(1)
  expect(readFileSync(join(repo, moved[0]!, "keep.txt"), "utf8")).toBe("kept")
  await running.logged("boot.moved-aside")
  expect(
    running.log().filter((line) => line.message.includes("examples")),
  ).toEqual([])
})

test("a Layer build that cannot be interrupted, and a failed build whose finalizer never ends, are skipped at the deadline, the boot goes on, and nothing the build acquired is released until it ends", async () => {
  const release = Deferred.makeUnsafe<void>()
  const first = { released: false, releasedWhileHeld: false }
  const second = Deferred.makeUnsafe<void>()
  const held = Plugin.make(
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            first.released = true
          }),
        )
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            first.releasedWhileHeld = first.released
          }).pipe(Effect.andThen(Deferred.await(release))),
          () => Deferred.succeed(second, undefined),
        )
      }),
    ),
  )
  const cleanup = Plugin.make(
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.await(release))
        return yield* new NoBuild()
      }),
    ),
  )
  const running = await scenario({
    plugins: [
      { name: "held", plugin: held },
      { name: "cleanup", plugin: cleanup },
      { name: "send-file", plugin: sendFile },
    ],
  })
  await running.logged("boot.ready")
  const status = (await running.chad(["status"])).stdout
  expect(status).toContain("plugin: send-file, 0 warnings")
  expect(status).toContain("plugin: held, skipped (")
  expect(status).toContain("plugin: cleanup, skipped (")
  expect(first.released).toBe(false)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(Deferred.await(second))
  expect(first.releasedWhileHeld).toBe(false)
})
