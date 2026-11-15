// PROTOTYPE for TIM-538 "Runtime and plugin loading mechanism". Throwaway.
//
// A tiny stand-in for the chad daemon. It snapshots work/, type-checks the snapshot, loads every
// plugin from it, swaps the running instances, commits and moves live/.
//
//   LOADER=bundle   esbuild to one CJS file per plugin, run with vm.compileFunction (default)
//   LOADER=rolldown the same, bundled with rolldown
//   LOADER=esm      plain import() of the .ts file from the snapshot directory
import { Plugin } from "chad"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as esbuild from "esbuild"
import * as rolldown from "rolldown"
import { execFileSync, spawnSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import { createRequire, SourceMap } from "node:module"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import * as vm from "node:vm"

export const APP = import.meta.dirname
export const DATA = process.env.CHAD_DATA ?? path.join(APP, "..", "data")
export const REPO = path.join(DATA, "repo")
export const WORK = path.join(REPO, "work")
export const VERSIONS = path.join(REPO, "versions")
export const LIVE = path.join(REPO, "live")
export const LOADER = process.env.LOADER ?? "bundle"
export const BUNDLED = LOADER !== "esm"
const BUILTIN_TOOLS = ["bash", "readFile"] // stands in for the names clanka and bundled plugins use

const started = performance.now()
const at = () => String(Math.round(performance.now() - started)).padStart(5) + "ms"
export const timeline: Array<string> = []
export const quiet = { on: false }

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

const git = (args: Array<string>, env: Record<string, string> = {}) =>
  execFileSync("git", args, { cwd: WORK, env: { ...process.env, ...env }, encoding: "utf8" }).trim()

export const init = (seed: string) => {
  fs.rmSync(DATA, { recursive: true, force: true })
  fs.mkdirSync(VERSIONS, { recursive: true })
  fs.cpSync(seed, WORK, { recursive: true })
  git(["init", "-q", "-b", "main"])
  git(["config", "user.name", "chad"])
  git(["config", "user.email", "chad@localhost"])
  // Outside the git repo, above both work/ and versions/. Node and tsc find effect and chad here
  // by walking up, and Node resolves the link to the host's real copy.
  fs.symlinkSync(path.join(APP, "node_modules"), path.join(REPO, "node_modules"))
  fs.writeFileSync(path.join(REPO, "package.json"), JSON.stringify({ private: true, type: "module" }))
}

// The working tree of work/ as a git tree, without touching the agent's index, HEAD or branch.
const snapshot = () => {
  const index = path.join(REPO, ".snapshot-index")
  const real = path.join(WORK, ".git", "index")
  if (fs.existsSync(real)) {
    // Reuse git's stat cache, and keep the index's mtime. git compares it with each file's mtime
    // to catch an edit made in the same clock tick, and a copy with a new mtime turns that off
    // (see racy-snapshot.sh).
    fs.copyFileSync(real, index)
    const stat = fs.statSync(real, { bigint: true })
    fs.utimesSync(index, Number(stat.atimeNs) / 1e9, Number(stat.mtimeNs) / 1e9)
  }
  const env = { GIT_INDEX_FILE: index }
  git(["add", "-A"], env)
  const tree = git(["write-tree"], env)
  const dir = path.join(VERSIONS, tree)
  const fresh = !fs.existsSync(dir)
  if (fresh) git(["checkout-index", "-a", "--prefix=" + dir + "/"], env)
  fs.rmSync(index, { force: true })
  return { tree, dir, fresh }
}

const checkout = (commit: string) => {
  const tree = git(["rev-parse", commit + "^{tree}"])
  const dir = path.join(VERSIONS, tree)
  if (!fs.existsSync(dir)) {
    const index = path.join(REPO, ".snapshot-index")
    const env = { GIT_INDEX_FILE: index }
    git(["read-tree", tree], env)
    git(["checkout-index", "-a", "--prefix=" + dir + "/"], env)
    fs.rmSync(index, { force: true })
  }
  return { tree, dir, fresh: false }
}

const commit = (tree: string, message: string) => {
  let parent: string | undefined
  try { parent = git(["rev-parse", "-q", "--verify", "refs/heads/applied"]) } catch {}
  const sha = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message])
  git(["update-ref", "refs/heads/applied", sha])
  return sha
}

const moveLive = (dir: string) => {
  const tmp = LIVE + ".next"
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(path.relative(REPO, dir), tmp)
  fs.renameSync(tmp, LIVE) // atomic: a boot sees the old version or the new one, never half
}

// Error text names files in the snapshot. The agent edits work/, so say work/.
const toWorkPaths = (text: string, dir: string) =>
  text.replaceAll(dir + "/", "work/")
    .replaceAll("versions/" + path.basename(dir) + "/", "work/")
    .replaceAll(pathToFileURL(dir).href + "/", "work/")

// ---------------------------------------------------------------------------------------------
// type-check
// ---------------------------------------------------------------------------------------------

const typecheck = (dir: string) => {
  const config = dir + ".tsconfig.json"
  fs.writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: "es2024", lib: ["es2024"], module: "nodenext", moduleResolution: "nodenext",
      strict: true, noEmit: true, skipLibCheck: true, types: ["node"],
      allowImportingTsExtensions: true, erasableSyntaxOnly: true, verbatimModuleSyntax: true
    },
    include: [path.basename(dir) + "/plugins/**/*.ts"]
  }))
  const out = spawnSync(path.join(APP, "node_modules/.bin/tsc"), ["-p", config, "--pretty", "false"], {
    cwd: REPO, encoding: "utf8"
  })
  fs.rmSync(config, { force: true })
  return { ok: out.status === 0, output: (out.stdout + out.stderr).trim() }
}

// ---------------------------------------------------------------------------------------------
// loaders
// ---------------------------------------------------------------------------------------------

const hostRequire = createRequire(import.meta.url)
export const finalized = { modules: 0 }
const registry = new FinalizationRegistry(() => { finalized.modules++ })

const discover = (dir: string) => {
  const plugins = path.join(dir, "plugins")
  if (!fs.existsSync(plugins)) return []
  const found: Array<{ name: string; file: string }> = []
  for (const entry of fs.readdirSync(plugins, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push({ name: entry.name.slice(0, -3), file: path.join(plugins, entry.name) })
    } else if (entry.isDirectory() && fs.existsSync(path.join(plugins, entry.name, "index.ts"))) {
      found.push({ name: entry.name, file: path.join(plugins, entry.name, "index.ts") })
    }
  }
  return found
}

interface Loaded { readonly module: any; readonly hash: string; readonly map?: SourceMap; readonly filename?: string }

const loadEsm = async (file: string): Promise<Loaded> => {
  const module = await import(pathToFileURL(file).href)
  return { module, hash: file }
}

// Only the plugin's own files go into the bundle. Every package import stays a require call,
// which the loader answers with the host's copy.
const bundleEsbuild = async (file: string, dir: string) => {
  const result = await esbuild.build({
    entryPoints: [file], absWorkingDir: dir, bundle: true, write: false, outdir: dir,
    format: "cjs", platform: "node", target: "node24", sourcemap: "external", logLevel: "silent",
    packages: "external"
  })
  return {
    code: result.outputFiles.find((f) => f.path.endsWith(".js"))!.text,
    map: JSON.parse(result.outputFiles.find((f) => f.path.endsWith(".map"))!.text)
  }
}

const bundleRolldown = async (file: string, dir: string) => {
  const result = await rolldown.build({
    input: file, cwd: dir, write: false, platform: "node", logLevel: "silent",
    external: /^[^./]/,
    output: { format: "cjs", exports: "named", sourcemap: "hidden", dir, codeSplitting: false }
  })
  const chunk = result.output[0]
  return { code: chunk.code, map: JSON.parse(JSON.stringify(chunk.map)) }
}

const loadBundle = async (file: string, dir: string): Promise<Loaded> => {
  const built = LOADER === "rolldown" ? await bundleRolldown(file, dir) : await bundleEsbuild(file, dir)
  const code = built.code
  const map = new SourceMap(built.map)
  const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 12)
  const filename = file.replace(/\.ts$/, ".bundle.cjs")
  const run = vm.compileFunction(code, ["require", "module", "exports"], { filename })
  const module = { exports: {} as any }
  const loaded = { module: module.exports, hash, map, filename }
  try {
    run(hostRequire, module, module.exports)
  } catch (error: any) {
    throw new Error(mapStack(String(error?.stack ?? error), loaded, dir).split("\n    at loadBundle")[0])
  }
  return { ...loaded, module: module.exports }
}

// Rewrites "bundle.cjs:line:col" frames to the source file they came from.
const mapStack = (text: string, loaded: Loaded | undefined, dir: string) => {
  if (!loaded?.map || !loaded.filename) return text
  const name = loaded.filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return text.replace(new RegExp(name + ":(\\d+):(\\d+)", "g"), (whole, line, column) => {
    const entry: any = loaded.map!.findEntry(Number(line) - 1, Number(column) - 1)
    if (!entry?.originalSource) return whole
    const source = entry.originalSource.startsWith("file:") ? new URL(entry.originalSource).pathname
      : path.resolve(dir, entry.originalSource)
    return source + ":" + (entry.originalLine + 1) + ":" + (entry.originalColumn + 1)
  })
}

// ---------------------------------------------------------------------------------------------
// plugin instances
// ---------------------------------------------------------------------------------------------

interface Instance {
  readonly name: string
  readonly version: string
  readonly hash: string
  readonly scope: Scope.Closeable
  readonly activated: Deferred.Deferred<void>
  readonly tools: Map<string, (params: any) => Effect.Effect<any, any>>
}

export let running = new Map<string, Instance>()
export let liveCommit = ""

const build = async (name: string, version: string, loaded: Loaded) => {
  const scope = Effect.runSync(Scope.make())
  const activated = Effect.runSync(Deferred.make<void>())
  const instance: Instance = { name, version, hash: loaded.hash, scope, activated, tools: new Map() }
  const services = Layer.mergeAll(
    Layer.succeed(Plugin.PluginContext, {
      name, version,
      log: (message: string) => Effect.sync(() => {
        if (timeline.length < 500) timeline.push(at() + "  " + name + "@" + version.slice(0, 7) + "  " + message)
      })
    }),
    Layer.succeed(Plugin.Turns, {
      start: (label: string) => Effect.andThen(Deferred.await(activated), Effect.sync(() => {
        timeline.push(at() + "  " + name + "@" + version.slice(0, 7) + "  TURN " + label)
      }))
    }),
    Layer.succeed((Plugin as any).Registry, {
      activated: Deferred.await(activated),
      addTools: (names: Array<string>, handlers: any) => Effect.sync(() => {
        for (const tool of names) instance.tools.set(tool, handlers[tool])
      })
    })
  )
  const exit = await Effect.runPromiseExit(
    Layer.buildWithScope(Layer.provide(loaded.module.default, services) as any, scope)
  )
  return { instance, exit }
}

const close = (instance: Instance) => Effect.runPromise(Scope.close(instance.scope, Exit.void))

export interface Outcome {
  readonly ok: boolean
  readonly errors: Array<string>
  readonly ms: Record<string, number>
  readonly reloaded: Array<string>
  readonly kept: Array<string>
}

// One code path for an apply, a revert and a boot. A boot passes check: false and a commit.
export const load = async (options: {
  readonly message?: string
  readonly commit?: string
  readonly check?: boolean
  readonly tolerant?: boolean // boot: skip a plugin that fails, load the rest
  readonly holdMs?: number // widen the window between building the new and closing the old
}): Promise<Outcome> => {
  const ms: Record<string, number> = {}
  const time = async <A>(label: string, f: () => A | Promise<A>) => {
    const t = performance.now()
    try { return await f() } finally { ms[label] = Math.round((performance.now() - t) * 10) / 10 }
  }
  const errors: Array<string> = []
  const snap = await time("snapshot", () => options.commit ? checkout(options.commit) : snapshot())
  const fail = async (built: Array<Instance>): Promise<Outcome> => {
    for (const instance of built) await close(instance)
    const live = fs.existsSync(LIVE) ? path.basename(fs.readlinkSync(LIVE)) : ""
    if (live !== snap.tree) {
      fs.rmSync(snap.dir, { recursive: true, force: true })
    }
    return { ok: false, errors: errors.map((e) => toWorkPaths(e, snap.dir)), ms, reloaded: [], kept: [] }
  }

  if (options.check !== false) {
    const checked = await time("tsc", () => typecheck(snap.dir))
    if (!checked.ok) {
      errors.push(checked.output)
      return fail([])
    }
  }

  const next = new Map<string, Instance>()
  const built: Array<Instance> = []
  const kept: Array<string> = []
  await time("load+build", async () => {
    for (const { name, file } of discover(snap.dir)) {
      let loaded: Loaded | undefined
      try {
        loaded = LOADER === "esm" ? await loadEsm(file) : await loadBundle(file, snap.dir)
      } catch (error: any) {
        const text = error?.errors && LOADER === "bundle"
          ? esbuild.formatMessagesSync(error.errors, { kind: "error", color: false }).join("").trim()
          : String(error?.message ?? error)
        errors.push(name + ": could not be loaded\n" + text)
        continue
      }
      // The bundle's hash covers the plugin and every local file it imports.
      const current = running.get(name)
      if (BUNDLED && current && current.hash === loaded.hash) {
        next.set(name, current)
        kept.push(name)
        continue
      }
      if (!Plugin.isPlugin(loaded.module.default)) {
        errors.push(name + ": the default export is not a Plugin. Wrap it in Plugin.make(...)")
        continue
      }
      registry.register(loaded.module.default, name)
      const { instance, exit } = await build(name, snap.tree, loaded)
      built.push(instance)
      if (Exit.isFailure(exit)) {
        errors.push(name + ": the Layer failed to build\n" + mapStack(Cause.pretty(exit.cause), loaded, snap.dir))
        continue
      }
      next.set(name, instance)
    }
    // Stands in for the trial Agent.makeWith, which dies on a tool name clash.
    const owners = new Map<string, string>(BUILTIN_TOOLS.map((tool) => [tool, "chad"]))
    for (const [name, instance] of next) {
      for (const tool of instance.tools.keys()) {
        const owner = owners.get(tool)
        if (owner) {
          errors.push(name + ': tool "' + tool + '" is already defined by ' + owner)
          if (options.tolerant) next.delete(name)
        } else owners.set(tool, name)
      }
    }
  })
  if (errors.length > 0 && !options.tolerant) return fail(built)

  if (options.holdMs) await new Promise((resolve) => setTimeout(resolve, options.holdMs))

  await time("commit+swap", async () => {
    liveCommit = options.commit ?? commit(snap.tree, options.message ?? "apply")
    moveLive(snap.dir)
    if (!options.commit) git(["reset", "-q", liveCommit]) // work/ now diffs against what is live
    const old = running
    running = next
    for (const [name, instance] of old) {
      if (next.get(name) !== instance) {
        if (timeline.length < 500) timeline.push(at() + "  " + name + "@" + instance.version.slice(0, 7) + "  -- closed --")
        await close(instance)
      }
    }
    for (const instance of built) {
      if (next.get(instance.name) === instance) {
        if (timeline.length < 500) timeline.push(at() + "  " + instance.name + "@" + instance.version.slice(0, 7) + "  -- activated --")
        Effect.runSync(Deferred.succeed(instance.activated, undefined))
      } else await close(instance)
    }
    // Nothing reads an old snapshot once its bundles are in memory.
    for (const entry of fs.readdirSync(VERSIONS)) {
      if (entry !== snap.tree && BUNDLED) fs.rmSync(path.join(VERSIONS, entry), { recursive: true, force: true })
    }
  })
  return {
    ok: true, errors: errors.map((e) => toWorkPaths(e, snap.dir)), ms, kept,
    reloaded: built.filter((i) => next.get(i.name) === i).map((i) => i.name)
  }
}

export const callTool = (name: string, params: unknown = {}) => {
  for (const instance of running.values()) {
    const handler = instance.tools.get(name)
    if (handler) return Effect.runPromise(handler(params))
  }
  return Promise.reject(new Error("no tool " + name))
}

export const state = async () => {
  const lines: Array<string> = []
  lines.push("  live   -> " + (fs.existsSync(LIVE) ? fs.readlinkSync(LIVE) : "(nothing applied)") + "   commit " + liveCommit.slice(0, 7))
  for (const instance of running.values()) {
    lines.push("  plugin " + instance.name.padEnd(8) + " version " + instance.version.slice(0, 7)
      + (BUNDLED ? "  bundle " + instance.hash : "") + "  tools [" + [...instance.tools.keys()].join(", ") + "]")
  }
  if (running.get("dice")) {
    lines.push('  rollDice({ sides: 6 }) = "' + await callTool("rollDice", { sides: 6 }) + '"')
    lines.push("  plugin's Effect.gen is the host's: " + ((await callTool("whichEffect")) === Effect.gen))
  }
  lines.push("  work/ git status: " + (git(["status", "--porcelain"]).replaceAll("\n", ", ") || "clean"))
  return lines.join("\n")
}

export const shutdown = async () => { for (const instance of running.values()) await close(instance) }
