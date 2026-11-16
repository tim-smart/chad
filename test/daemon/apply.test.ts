// Apply, check, revert and safe mode as the owner and the agent reach them: the commit, the swap at a session's next
// turn, the failed apply that keeps the last good version, the revert that saves work/ first, safe mode, the drain of
// a swap with a call in flight, and an apply that a crash or a killed CLI cut after its commit.
import { execFileSync } from "node:child_process"
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { Deferred, Effect, Exit, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { expect, onTestFinished, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import { git, applied, write } from "../support/applied.ts"
import * as Cli from "../support/cli.ts"
import { scenario, fresh, type Scenario } from "../support/driver.ts"
import { results, runs } from "../support/model.ts"
import { eventually, posted, says, sessions } from "../support/owner.ts"

/** A plugin with one tool, `roll`, which gives the face it was written with. */
const dice = (face: string) => `import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Plugin } from "chad"

const Roll = Tool.make("roll", {
  description: "Rolls a die.",
  parameters: Schema.Struct({}),
  success: Schema.String,
})
const Dice = Toolkit.make(Roll)

export default Plugin.make(
  Plugin.toolkit(Dice).pipe(
    Layer.provide(Dice.toLayer({ roll: () => Effect.succeed("face ${face}") })),
  ),
)
`

/** A plugin whose tool `hang` logs that it started and then never ends. */
const hanging = (
  version: string,
) => `import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Plugin } from "chad"

const Hang = Tool.make("hang", {
  description: "Hangs.",
  parameters: Schema.Struct({}),
  success: Schema.String,
})
const Hold = Toolkit.make(Hang)

export default Plugin.make(
  Plugin.toolkit(Hold).pipe(
    Layer.provide(
      Hold.toLayer({
        hang: () => Effect.logInfo("hang started ${version}").pipe(Effect.andThen(Effect.never)),
      }),
    ),
  ),
)
`

/**
 * Holds the next commit to `applied` inside its git process, after the ref moved and before the process returns, until
 * `release` is called. The hook keeps the fifo open itself, so the release never blocks, and one whose git process
 * was killed has nothing left to release.
 */
const holdCommit = (work: string) => {
  const fifo = join(work, ".git", "test-release")
  const marker = join(work, ".git", "test-held")
  execFileSync("mkfifo", [fifo])
  writeFileSync(
    join(work, ".git", "hooks", "reference-transaction"),
    [
      "#!/bin/sh",
      "input=$(cat)",
      '[ "$1" = committed ] || exit 0',
      'case "$input" in *" refs/heads/applied"*) ;; *) exit 0 ;; esac',
      'rm -f "$0"',
      `exec 3<> '${fifo}'`,
      `: > '${marker}'`,
      "read -r line <&3",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return {
    held: () =>
      eventually(
        () => existsSync(marker),
        (held) => held,
      ),
    release: () => {
      try {
        const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
        writeSync(fd, "go\n")
        closeSync(fd)
      } catch {
        // No reader: the hook is gone with its git process.
      }
      rmSync(fifo)
      rmSync(marker)
    },
  }
}

/** Runs one turn whose script rolls, and gives what the script printed. */
const roll = async (
  running: Scenario,
  thread: Parameters<typeof says>[1],
  text: string,
) => {
  const ended = running
    .log()
    .filter((line) => line.annotations["event"] === "turn.ended").length
  await running.fakes.model.script([
    runs("console.log(await roll({}))"),
    { text: "done" },
  ])
  await says(running, thread, text)
  await eventually(
    () =>
      running.log().filter((line) => line.annotations["event"] === "turn.ended")
        .length,
    (count) => count > ended,
  )
  const calls = await running.fakes.model.calls()
  return {
    output: results(calls[1]).at(-1) ?? "",
    system: JSON.stringify(calls[0]?.body),
  }
}

test("SWAP-1 SWAP-2 SWAP-4 LOAD-14 LOAD-23 LOAD-53 LOAD-70 REC-82 REC-86 REC-116 REC-129 CLI-45 CLI-125b CLI-125c CLI-125d CLI-138b SELF-38 REC-137 REC-139 REC-154 an apply commits work/ and loads it at the session's next turn, a failed apply exits 1 and keeps the last good version, a revert saves work/ first, and safe mode unloads the repo's plugins until it goes off", async () => {
  const running = await scenario()
  const repo = join(running.data, "repo")
  const work = join(repo, "work")
  const log = async () =>
    JSON.parse((await running.chad(["log", "--json"])).stdout) as Array<{
      commit: string
      session: string
      message: string
    }>
  expect((await log()).map(({ message }) => message)).toEqual(["First commit"])
  expect((await running.chad(["status"])).stdout).toContain(
    "work: no changes since the applied commit",
  )

  // A check commits nothing.
  write(work, { "plugins/dice.ts": dice("one") })
  expect((await running.chad(["status"])).stdout).toContain(
    "work: holds changes that are not applied",
  )
  const checked = await running.chad(["check"])
  expect(checked).toMatchObject({
    code: 0,
    stdout: Messages.checkPassed + "\n",
  })
  expect(await log()).toHaveLength(1)

  expect((await running.chad(["apply", "-m", "Add dice"])).code).toBe(0)
  const thread = await running.fakes.chat.makeThread("direct")
  expect((await roll(running, thread, "roll")).output).toContain("face one")

  // An apply the agent runs carries its session, and posts one line in the session's thread.
  const session = String(sessions(running)[0]?.["id"])
  write(work, { "plugins/dice.ts": dice("two") })
  expect(
    (
      await running.chad(["apply", "-m", "Second face"], {
        CHAD_SESSION: session,
      })
    ).code,
  ).toBe(0)
  const [second] = await log()
  expect(second).toMatchObject({ message: "Second face", session })
  expect((await running.chad(["status"])).stdout).toContain(
    `applied: ${second!.commit.slice(0, 7)} Second face`,
  )
  expect(await posted(running, thread)).toContain(
    `-# ${Messages.appliedLine(second!.commit.slice(0, 7), "Second face")}`,
  )
  expect((await roll(running, thread, "roll again")).output).toContain(
    "face two",
  )

  // A type error and a Layer that never builds each fail the apply, which changes nothing.
  const live = readlinkSync(join(repo, "live"))
  write(work, { "plugins/dice.ts": "export default 1 +\n" })
  const typed = await running.chad(["apply", "-m", "Broken"])
  expect(typed.code).toBe(1)
  expect(typed.stderr).toContain("work/plugins/dice.ts")
  write(work, {
    "plugins/dice.ts": dice("three"),
    "plugins/stuck.ts":
      'import { Effect, Layer } from "effect"\nimport { Plugin } from "chad"\n\nexport default Plugin.make(Layer.effectDiscard(Effect.never))\n',
  })
  const stuck = await running.chad(["apply", "-m", "Stuck"])
  expect(stuck.code).toBe(1)
  expect(stuck.stderr).toContain("stuck")
  expect(await log()).toHaveLength(3)
  expect(readlinkSync(join(repo, "live"))).toBe(live)
  expect((await roll(running, thread, "still two")).output).toContain(
    "face two",
  )

  // A revert that would write over an ignored file, which its save does not hold, is refused and changes nothing.
  write(join(work, ".git/info"), { exclude: "notes.local\nplugins/dice.ts\n" })
  write(work, { "notes.local": "mine" })
  const obstructed = await running.chad(["revert"])
  expect(obstructed.code).toBe(1)
  expect(obstructed.stderr).toContain("plugins/dice.ts")
  expect(readFileSync(join(work, "plugins/dice.ts"), "utf8")).toContain(
    "face three",
  )
  expect(await log()).toHaveLength(3)

  // A revert goes back to the commit before the current one, and what work/ held is kept under a saved ref. An
  // ignored file is neither saved nor deleted, and a file made after the save, while the revert runs, stays.
  write(join(work, ".git/info"), { exclude: "notes.local\n" })
  const hold = holdCommit(work)
  const reverting = Cli.start(["revert"], { CHAD_DATA: running.data })
  await hold.held()
  write(work, { "draft.md": "written during the revert" })
  hold.release()
  const reverted = await reverting.done
  expect(reverted.code).toBe(0)
  expect(readFileSync(join(work, "draft.md"), "utf8")).toBe(
    "written during the revert",
  )
  const saved = /refs\/chad\/saved\/\S+/
    .exec(reverted.stdout)?.[0]
    .replace(/\.$/, "")
  expect(git(work, ["show", `${saved}:plugins/stuck.ts`])).toContain(
    "Effect.never",
  )
  expect(readFileSync(join(work, "plugins/dice.ts"), "utf8")).toContain(
    "face one",
  )
  expect(existsSync(join(work, "plugins/stuck.ts"))).toBe(false)
  expect(readFileSync(join(work, "notes.local"), "utf8")).toBe("mine")
  expect(git(work, ["ls-tree", "-r", "--name-only", saved!])).not.toContain(
    "notes.local",
  )
  expect((await log()).map(({ message }) => message)).toEqual([
    Messages.revertMessage((await log())[2]!.commit.slice(0, 7)),
    "Second face",
    "Add dice",
    "First commit",
  ])
  expect((await roll(running, thread, "after the revert")).output).toContain(
    "face one",
  )

  // Safe mode from chat: the repo's tools are gone and the prompt says so until it goes off.
  await says(running, thread, "/safe on")
  await eventually(
    () => posted(running, thread),
    (texts) => texts.includes(Messages.safeState("toggle")),
  )
  expect((await running.chad(["status"])).stdout).toContain(
    "safe mode: on (chad safe on)",
  )
  const safe = await roll(running, thread, "in safe mode")
  expect(safe.system).toContain(Messages.safePrompt)
  expect(safe.output).not.toContain("face one")
  expect((await running.chad(["safe", "off"])).code).toBe(0)
  const back = await roll(running, thread, "safe mode is off")
  expect(back.system).not.toContain(Messages.safePrompt)
  expect(back.output).toContain("face one")
}, 60_000)

const slowTools = Toolkit.make(
  Tool.make("hang", {
    description: "Hangs.",
    parameters: Schema.Struct({}),
    success: Schema.String,
  }),
  Tool.make("ping", {
    description: "Pings.",
    parameters: Schema.Struct({}),
    success: Schema.String,
  }),
)

test("SWAP-6 SWAP-44 SWAP-46 SWAP-69 SWAP-113 SWAP-153 CLI-40 LOAD-75 TST-202 a swap interrupts a call that outlives the drain, the running turn keeps its tools and gets the refusal, a command behind it waits in the queue, and the next turn has the new version", async () => {
  const started = Deferred.makeUnsafe<void>()
  const building = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let builds = 0
  // The second build, which is the reload's, holds the queue until the test lets it go.
  const slow = Plugin.make(
    Layer.merge(
      Plugin.toolkit(slowTools).pipe(
        Layer.provide(
          slowTools.toLayer({
            hang: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
              ),
            ping: () => Effect.succeed("pong"),
          }),
        ),
      ),
      Layer.effectDiscard(
        Effect.suspend(() =>
          ++builds === 2
            ? Deferred.succeed(building, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              )
            : Effect.void,
        ),
      ),
    ),
  )
  const running = await scenario({ plugins: [{ name: "slow", plugin: slow }] })
  const { fakes } = running
  fakes.model.script([
    runs("await hang({})"),
    runs("console.log(await ping({}))"),
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hang")
  await Effect.runPromise(Deferred.await(started))

  const reload = Cli.start(["plugin", "reload", "slow"], {
    CHAD_DATA: running.data,
  })
  // The reload holds the queue, so a check that comes after it waits and says so.
  await Effect.runPromise(Deferred.await(building))
  const check = Cli.start(["check"], { CHAD_DATA: running.data })
  await check.printed(Messages.queueWaiting("chad plugin reload"))
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect((await reload.done).code).toBe(0)
  expect((await check.done).code).toBe(0)

  await running.logged("turn.ended")
  const calls = await fakes.model.calls()
  expect(results(calls[1]).join("\n")).toContain(Messages.toolCut("hang", true))
  expect(results(calls[2]).join("\n")).toContain(Messages.toolChanged("ping"))
  expect(
    running.log().some((line) => line.annotations["event"] === "swap.overrun"),
  ).toBe(false)

  fakes.model.script([runs("console.log(await ping({}))"), { text: "done" }])
  await says(running, thread, "ping")
  await eventually(
    () =>
      running.log().filter((line) => line.annotations["event"] === "turn.ended")
        .length,
    (count) => count >= 2,
  )
  expect(results((await fakes.model.calls())[1]).join("\n")).toContain("pong")
}, 30_000)

test("REC-48 LOAD-55 LOAD-89 a boot after a crash between an apply's commit and its link loads the head of applied, points live at it and drops the version live named", async () => {
  const directory = fresh()
  const repo = join(directory, "data", "repo")
  applied(repo, { "plugins/dice.ts": dice("committed") })
  write(join(repo, "versions", "old"), { "plugins/dice.ts": dice("stale") })
  symlinkSync(join("versions", "old"), join(repo, "live"))
  const running = await scenario({ directory })
  const thread = await running.fakes.chat.makeThread("direct")
  expect((await roll(running, thread, "roll")).output).toContain(
    "face committed",
  )
  const tree = git(join(repo, "work"), ["rev-parse", "applied^{tree}"])
  expect(readlinkSync(join(repo, "live"))).toBe(join("versions", tree))
  expect(readdirSync(join(repo, "versions"))).toEqual([tree])
}, 30_000)

test("CLI-43 CLI-44 REC-34 REC-56 a killed CLI cuts neither an apply once its commit moved applied, which finishes in the daemon and loads the change, nor safe on once the toggle is stored", async () => {
  const running = await scenario({ env: { CHAD_LOG_LEVEL: "debug" } })
  const work = join(running.data, "repo", "work")
  write(work, { "plugins/hold.ts": hanging("one") })
  expect((await running.chad(["apply", "-m", "Hold one"])).code).toBe(0)

  // The CLI is killed while the commit's git process holds, after applied moved and before the process returns. The
  // status call that follows comes back once the daemon has seen the client go.
  write(work, { "plugins/hold.ts": hanging("two") })
  const hold = holdCommit(work)
  const apply = Cli.start(["apply", "-m", "Hold two"], {
    CHAD_DATA: running.data,
  })
  await hold.held()
  apply.child.kill("SIGKILL")
  await apply.done
  expect((await running.chad(["status"])).code).toBe(0)
  hold.release()
  // The cancelled call ends only once the apply has.
  await running.logged("rpc.cancelled")
  const commit = git(work, ["rev-parse", "applied"])
  const done = running
    .log()
    .find(
      (line) =>
        line.annotations["event"] === "apply.done" &&
        line.annotations["commit"] === commit,
    )
  expect(done?.annotations["swapped"]).toBe("hold")
  const tree = git(work, ["rev-parse", "applied^{tree}"])
  expect(readlinkSync(join(running.data, "repo", "live"))).toBe(
    join("versions", tree),
  )
  running.fakes.model.script([runs("await hang({})"), { text: "done" }])
  const thread = await running.fakes.chat.makeThread("direct")
  await says(running, thread, "hang")
  await running.logged(
    "plugin.log",
    (line) => line.message === "hang started two",
  )

  // The call in flight holds safe on in its drain, and its CLI is killed once the toggle is stored. The repo's plugin
  // still goes.
  const status = async () =>
    JSON.parse((await running.chad(["status", "--json"])).stdout) as {
      repository: { safe: string }
      plugins: Array<{ name: string }>
    }
  const safe = Cli.start(["safe", "on"], { CHAD_DATA: running.data })
  await eventually(status, (report) => report.repository.safe === "toggle")
  safe.child.kill("SIGKILL")
  await safe.done
  await eventually(
    () =>
      running
        .log()
        .filter((line) => line.annotations["event"] === "rpc.cancelled"),
    (lines) => lines.length === 2,
  )
  expect((await status()).plugins.map(({ name }) => name)).not.toContain("hold")
}, 30_000)

test("TST-39 SWAP-4 on the Codex side a swap rebuilds the session's Agent at its next turn and keeps its model layer, so the socket the first turn opened carries the second", async () => {
  const running = await scenario({
    codex: "token",
    env: {
      CHAD_MODEL: "openai/gpt-6-astra/medium",
      CHAD_OPENAI_API_KEY: undefined,
    },
  })
  const work = join(running.data, "repo", "work")
  write(work, { "plugins/dice.ts": dice("one") })
  expect((await running.chad(["apply", "-m", "Add dice"])).code).toBe(0)
  const thread = await running.fakes.chat.makeThread("direct")
  expect((await roll(running, thread, "roll")).output).toContain("face one")
  const opened = running.model.opened().length
  expect(opened).toBeGreaterThan(0)
  write(work, { "plugins/dice.ts": dice("two") })
  expect((await running.chad(["apply", "-m", "Second face"])).code).toBe(0)
  expect((await roll(running, thread, "roll again")).output).toContain(
    "face two",
  )
  expect(running.model.opened()).toHaveLength(opened)
}, 30_000)

const ownerTools = Toolkit.make(
  Tool.make("owners", {
    description: "Says the owners.",
    parameters: Schema.Struct({}),
    success: Schema.String,
  }),
)

const spareTools = Toolkit.make(
  Tool.make("spare", {
    description: "Does nothing.",
    parameters: Schema.Struct({}),
    success: Schema.String,
  }),
)

test("CLI-120b SWAP-99 SWAP-141 API-33 an owner change rebuilds the plugins with the new owners, a rebuilt plugin cannot take a tool name from a version that stays, and when an owner was removed a plugin that fails to rebuild is unloaded, even when the CLI is killed during the rebuild", async () => {
  let build: "builds" | "fails" | "holds" = "builds"
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const guard = Plugin.make(
    Plugin.toolkit(ownerTools).pipe(
      Layer.provide(
        ownerTools.toLayer(
          Effect.gen(function* () {
            const { owners } = yield* Plugin.PluginContext
            if (build === "holds") {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            if (build !== "builds")
              return yield* Effect.die("the guard cannot build")
            return ownerTools.of({
              owners: () => Effect.succeed(`owners ${owners.join(",")}`),
            })
          }),
        ),
      ),
    ),
  )
  // The taker's next version takes the guard's tool name while it is set to.
  let taking = false
  const taker = Plugin.make(
    Layer.unwrap(
      Effect.sync(() =>
        taking
          ? Plugin.toolkit(ownerTools).pipe(
              Layer.provide(
                ownerTools.toLayer({
                  owners: () => Effect.succeed("taken"),
                }),
              ),
            )
          : Plugin.toolkit(spareTools).pipe(
              Layer.provide(
                spareTools.toLayer({ spare: () => Effect.succeed("spare") }),
              ),
            ),
      ),
    ),
  )
  const running = await scenario({
    env: { CHAD_LOG_LEVEL: "debug" },
    plugins: [
      { name: "guard", plugin: guard },
      { name: "taker", plugin: taker },
    ],
  })
  const { fakes } = running
  const thread = await fakes.chat.makeThread("direct")
  const owners = async (text: string) => {
    const ended = running
      .log()
      .filter((line) => line.annotations["event"] === "turn.ended").length
    fakes.model.script([
      runs("console.log(await owners({}))"),
      { text: "done" },
    ])
    await says(running, thread, text)
    await eventually(
      () =>
        running
          .log()
          .filter((line) => line.annotations["event"] === "turn.ended").length,
      (count) => count > ended,
    )
    return results((await fakes.model.calls())[1]).at(-1) ?? ""
  }
  expect(await owners("who")).not.toContain("ada")

  expect((await running.chad(["owner", "add", "local", "ada"])).code).toBe(0)
  expect(await owners("who now")).toContain("ada")

  // An owner added while the build fails leaves the running version, which status marks. The taker's new version
  // would take the tool of the version that stays, so it keeps its running version too.
  build = "fails"
  taking = true
  expect((await running.chad(["owner", "add", "local", "bob"])).code).toBe(0)
  const kept = await owners("who with bob")
  expect(kept).toContain("ada")
  expect(kept).not.toContain("bob")
  const mark = Messages.runningPrevious("owners", "").split(":")[0]
  const marked = (await running.chad(["status"])).stdout
  expect(marked).toContain(`plugin: guard, ${mark}:`)
  expect(marked).toContain(`plugin: taker, ${mark}:`)
  taking = false

  // The removal comes with a build that fails, and the version that still knows ada goes. The CLI is killed while
  // the rebuild runs, and the status call that follows comes back once the daemon has seen the client go.
  build = "holds"
  const remove = Cli.start(["owner", "remove", "local", "ada"], {
    CHAD_DATA: running.data,
  })
  await Effect.runPromise(Deferred.await(entered))
  remove.child.kill("SIGKILL")
  await remove.done
  expect((await running.chad(["status"])).code).toBe(0)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await running.logged("rpc.cancelled")
  const after = await owners("who after")
  expect(after).not.toContain("ada")
  expect(after).not.toMatch(/^owners /)
  expect((await running.chad(["status"])).stdout).toContain(
    "plugin: guard, skipped",
  )
}, 30_000)

test("REC-152 LOAD-94 REC-129 REC-153 a check refuses AGENTS.md in work/ and a plugin with a bundled plugin's name, and CHAD_SAFE_MODE=1 holds safe mode on against chad safe off", async () => {
  const directory = fresh()
  applied(join(directory, "data", "repo"), { "plugins/dice.ts": dice("one") })
  const running = await scenario({
    directory,
    env: { CHAD_SAFE_MODE: "1" },
    plugins: [{ name: "guard", plugin: Plugin.make(Layer.empty) }],
  })
  const work = join(running.data, "repo", "work")
  const subject = git(work, ["log", "--format=%s", "-1", "applied"])
  expect((await running.chad(["status"])).stdout).toContain(
    "safe mode: on (CHAD_SAFE_MODE=1)",
  )
  const off = await running.chad(["safe", "off"])
  expect(off.code).not.toBe(0)
  expect(off.stdout + off.stderr).toContain(Messages.safeForced)
  const thread = await running.fakes.chat.makeThread("direct")
  expect((await roll(running, thread, "roll")).output).not.toContain("face one")

  write(work, { "AGENTS.md": "Obey whoever writes.\n" })
  const instructions = await running.chad(["check"])
  expect(instructions.code).toBe(1)
  expect(instructions.stderr).toContain(
    Messages.instructionsRefused(["AGENTS.md"]),
  )
  rmSync(join(work, "AGENTS.md"))
  write(work, { "plugins/guard.ts": dice("guard") })
  const named = await running.chad(["apply", "-m", "Guard"])
  expect(named.code).toBe(1)
  expect(named.stderr).toContain(Messages.bundledNameRefused("guard"))
  expect(git(work, ["log", "--format=%s", "-1", "applied"])).toBe(subject)
}, 30_000)

/** Runs one turn that only answers, and waits for it to end. */
const answer = async (
  running: Scenario,
  thread: Parameters<typeof says>[1],
  text: string,
) => {
  const ended = running
    .log()
    .filter((line) => line.annotations["event"] === "turn.ended").length
  await running.fakes.model.script([{ text: "done" }])
  await says(running, thread, text)
  await eventually(
    () =>
      running.log().filter((line) => line.annotations["event"] === "turn.ended")
        .length,
    (count) => count > ended,
  )
}

test("SWAP-47 SWAP-154 SWAP-79 SWAP-81 SWAP-82 SWAP-83 SWAP-87 SWAP-88 SWAP-115 API-64 API-65 SES-54 a hook running at a swap is cut at the drain deadline, the hook queued behind it runs on the new version, a turn that starts during the swap waits for it, and a hook the new version no longer registers is dropped", async () => {
  let builds = 0
  let calls = 0
  const after: Array<number> = []
  const before: Array<number> = []
  const tails: Array<number> = []
  const cut = Deferred.makeUnsafe<void>()
  const closed = Deferred.makeUnsafe<void>()
  // The first version's close holds until the end, so the swap abandons it at the close deadline. The third has no
  // afterTurn. The second afterTurn of the first version would hold if it started, and the second version's interrupts
  // itself, which ends its job and not the plugin's queue.
  const notes = Plugin.make(
    Layer.unwrap(
      Effect.sync(() => {
        const version = ++builds
        const turnStarted = Plugin.beforeTurn(() =>
          Effect.sync(() => {
            before.push(version)
          }),
        )
        if (version === 3) return turnStarted
        const turnEnded = Plugin.afterTurn(
          () =>
            Effect.suspend(() => {
              const call = ++calls
              after.push(version)
              return call === 1
                ? Effect.never.pipe(
                    Effect.onInterrupt(() => Deferred.succeed(cut, undefined)),
                  )
                : call === 3
                  ? Effect.never
                  : Effect.void
            }),
          { timeout: "1 hour" },
        )
        const tail = Plugin.afterTurn(() =>
          Effect.sync(() => {
            tails.push(version)
          }).pipe(
            Effect.andThen(version === 1 ? Effect.never : Effect.interrupt),
          ),
        )
        const close = Layer.effectDiscard(
          Effect.addFinalizer(() =>
            version === 1 ? Deferred.await(closed) : Effect.void,
          ),
        )
        return Layer.mergeAll(turnStarted, turnEnded, tail, close)
      }),
    ),
  )
  const running = await scenario({
    plugins: [{ name: "notes", plugin: notes }],
  })
  // The stop at the end waits for the abandoned close, so the close ends first (SWAP-154).
  onTestFinished(() => {
    Deferred.doneUnsafe(closed, Exit.void)
  })
  const thread = await running.fakes.chat.makeThread("direct")
  const reload = () =>
    Cli.start(["plugin", "reload", "notes"], { CHAD_DATA: running.data })
  const logged = (event: string) =>
    running
      .log()
      .filter(
        (line) =>
          line.annotations["event"] === event &&
          line.annotations["plugin"] === "notes",
      )

  // The first turn's hook holds, and the second turn's waits behind it.
  await answer(running, thread, "one")
  await eventually(
    () => after,
    (list) => list.length === 1,
  )
  await answer(running, thread, "two")

  // The drain cuts the running hook. A turn that starts while the old version's close hangs waits for the new one.
  const first = reload()
  await Effect.runPromise(Deferred.await(cut))
  await answer(running, thread, "three")
  expect((await first.done).code).toBe(0)
  expect(before).toEqual([1, 1, 2])
  expect(logged("hook.failed")).toHaveLength(1)
  expect(logged("swap.close-abandoned")).toHaveLength(1)
  // The queued hook ran on the new version, and the third turn's hook now holds. The rest of the cut job did not start on
  // the old version, and the queue outlived the close that cut it.
  await eventually(
    () => after,
    (list) => list.length === 3,
  )
  expect(after).toEqual([1, 2, 2])
  expect(tails).toEqual([2])

  // A hook queued behind the held one, of a kind the next version does not register, is dropped and logged.
  await answer(running, thread, "four")
  expect((await reload().done).code).toBe(0)
  await eventually(
    () => logged("hook.dropped"),
    (lines) => lines.length === 1,
  )
  expect(after).toEqual([1, 2, 2])
  expect(tails).toEqual([2])
}, 30_000)

test("SWAP-101 SWAP-103 CLI-43 REC-121 a graceful stop while an apply's swap waits on a call in flight abandons the swap and exits 0, and the next boot loads what the apply committed", async () => {
  const directory = fresh()
  const first = await scenario({ directory })
  const work = join(first.data, "repo", "work")
  write(work, { "plugins/hold.ts": hanging("one") })
  expect((await first.chad(["apply", "-m", "Hold one"])).code).toBe(0)
  first.fakes.model.script([runs("await hang({})"), { text: "done" }])
  const thread = await first.fakes.chat.makeThread("direct")
  await says(first, thread, "hang")
  await first.logged(
    "plugin.log",
    (line) => line.message === "hang started one",
  )

  // The call in flight holds the swap in its drain. The stop comes once the link moved and work/ was reset to the
  // commit, the steps right before the swap.
  write(work, { "plugins/hold.ts": hanging("two") })
  const apply = Cli.start(["apply", "-m", "Hold two"], {
    CHAD_DATA: first.data,
  })
  const tree = await eventually(
    () => git(work, ["rev-parse", "-q", "--verify", "applied^{tree}"]),
    (tree) =>
      readlinkSync(join(first.data, "repo", "live")) ===
        join("versions", tree) &&
      git(work, ["write-tree"]) === tree &&
      git(work, ["log", "--format=%s", "-1", "applied"]) === "Hold two",
  )
  expect(await first.stop()).toBe(0)
  await apply.done

  // The swap was abandoned, so the version that holds the call was never replaced in this daemon.
  const commit = git(work, ["rev-parse", "applied"])
  const done = first
    .log()
    .find(
      (line) =>
        line.annotations["event"] === "apply.done" &&
        line.annotations["commit"] === commit,
    )
  expect(done?.annotations["swapped"] ?? "").toBe("")
  expect(
    first
      .log()
      .some(
        (line) =>
          line.annotations["event"] === "plugin.log" &&
          line.message === "hang started two",
      ),
  ).toBe(false)

  // The next boot loads the committed version.
  const second = await scenario({ directory })
  // The log goes on from the first daemon's, so the second boot is the second boot.ready in it.
  await eventually(
    () =>
      second.log().filter((line) => line.annotations["event"] === "boot.ready")
        .length,
    (count) => count === 2,
  )
  second.fakes.model.script([runs("await hang({})"), { text: "done" }])
  await says(second, await second.fakes.chat.makeThread("direct"), "hang")
  await second.logged(
    "plugin.log",
    (line) => line.message === "hang started two",
  )
  expect(readlinkSync(join(second.data, "repo", "live"))).toBe(
    join("versions", tree),
  )
}, 30_000)
