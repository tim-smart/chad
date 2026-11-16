/**
 * The loader of plugins from an exported tree (docs/spec/07-plugin-loading.md): which files are plugins, the
 * type-check, the bundle and the run of a bundle, and the rewrite of error text to `work/` paths. The daemon never
 * imports a plugin file (LOAD-66). It bundles it with esbuild into one CJS file held in memory and runs that with the
 * host's own `require` (LOAD-7 to LOAD-12, LOAD-16).
 */
import { createHash } from "node:crypto"
import * as Module from "node:module"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as vm from "node:vm"
import { Cause, Data, Effect, FileSystem, Option, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as esbuild from "esbuild"
import * as Messages from "../Messages.ts"
import * as Plugin from "../Plugin.ts"

/**
 * The compiler options of every type-check of plugins: `chad check`, `chad apply`, the image's test and the
 * type-check of the fixture plugins all read them from here (LOAD-77 to LOAD-80, TST-188).
 */
export const compilerOptions = {
  target: "es2024",
  lib: ["es2024"],
  module: "nodenext",
  moduleResolution: "nodenext",
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: ["node"],
  allowImportingTsExtensions: true,
  erasableSyntaxOnly: true,
  verbatimModuleSyntax: true,
} as const

/** A check or a load that failed, with the text the owner and the agent read. */
export class LoadError extends Data.TaggedError("LoadError")<{
  readonly message: string
}> {}

/** A plugin's entry file, by its path inside the tree. */
export interface Found {
  readonly name: string
  /** The entry file inside the tree, as `plugins/<name>.ts` or `plugins/<name>/index.ts`. */
  readonly file: string
}

/** A plugin that could not be loaded, with the error the owner and the agent read. */
export interface Skipped {
  readonly name: string
  readonly message: string
}

/** The text of a load's failure. */
const messageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof LoadError ? error.message : Cause.pretty(cause)
}

/** A plugin's name is lower-case letters, digits and hyphens, since it goes into the name of its table (LOAD-92). */
const named = /^[a-z0-9-]+$/

/**
 * The plugins of a tree. Every `.ts` file directly in `plugins/` is one, and so is every directory there with an
 * `index.ts` (LOAD-5, LOAD-73). A name kept both ways or breaking the name rule is a problem (LOAD-72, LOAD-92).
 */
export const discover = Effect.fnUntraced(function* (tree: string) {
  const fs = yield* FileSystem.FileSystem
  const directory = join(tree, "plugins")
  const found: Array<Found> = []
  const problems: Array<Skipped> = []
  if (!(yield* fs.exists(directory))) return { found, problems }
  const files = new Map<string, Array<string>>()
  for (const entry of (yield* fs.readDirectory(directory)).sort()) {
    // An entry that cannot be read, such as a link to a missing file, is one plugin's problem: a `.ts` entry goes on
    // as a file and fails its own bundle, and the others load.
    const info = yield* Effect.option(fs.stat(join(directory, entry)))
    const type = Option.isSome(info) ? info.value.type : "File"
    const add = (name: string, file: string) =>
      files.set(name, [...(files.get(name) ?? []), file])
    if (type === "File" && entry.endsWith(".ts")) {
      add(entry.slice(0, -3), `plugins/${entry}`)
    } else if (
      type === "Directory" &&
      (yield* fs.exists(join(directory, entry, "index.ts")))
    ) {
      add(entry, `plugins/${entry}/index.ts`)
    }
  }
  for (const [name, [file, ...others]] of [...files].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (others.length > 0) {
      problems.push({
        name,
        message: Messages.twoEntries(
          name,
          `work/${file}`,
          `work/${others.join(", work/")}`,
        ),
      })
    } else if (!named.test(name)) {
      problems.push({
        name,
        message: Messages.pluginName(name, `work/${file}`),
      })
    } else {
      found.push({ name, file: file! })
    }
  }
  return { found, problems }
})

/** Error text names files the agent edits, so a path inside the tree becomes a `work/` path (LOAD-30, LOAD-41). */
export const toWork = (text: string, tree: string, cwd?: string) => {
  const prefixes = [
    pathToFileURL(tree).href + "/",
    tree + "/",
    ...(cwd === undefined ? [] : [relative(cwd, tree) + "/"]),
  ]
  return prefixes.reduce(
    (result, prefix) => result.replaceAll(prefix, "work/"),
    text,
  )
}

const typescript = join(
  dirname(
    Module.createRequire(import.meta.url).resolve("typescript/package.json"),
  ),
  "bin/tsc",
)

/**
 * A missing module that is a package, and not a file of the plugin's own, is told what a plugin can import (LOAD-22).
 * A side-effect import of one fails with TS2882 in place of TS2307.
 */
const missingPackage =
  /^(.*error TS(?:2307|2882): .*'[^./][^']*')(?: or its corresponding type declarations)?\.?$/

/**
 * Type-checks the plugins of a tree with the image's `tsc` (LOAD-25), from `repo/` so that `effect`, `chad` and the
 * Node types resolve through `repo/node_modules` (LOAD-27). chad writes the tsconfig itself, next to the tree, and
 * deletes it after the run, so no file in the repo can loosen the check (LOAD-29, REC-27). It covers
 * `plugins/**\/*.ts` and nothing else (LOAD-81). The result is the rewritten output, or nothing when the check
 * passed.
 */
export const typecheck = Effect.fnUntraced(function* (
  repo: string,
  tree: string,
) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const config = `${tree}.tsconfig.json`
  yield* fs.writeFileString(
    config,
    JSON.stringify({
      compilerOptions,
      include: [`${basename(tree)}/plugins/**/*.ts`],
    }),
  )
  const [output, code] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [typescript, "-p", config, "--pretty", "false"],
          { cwd: repo },
        ),
      )
      return yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
        { concurrency: 2 },
      )
    }),
  ).pipe(Effect.ensuring(Effect.ignore(fs.remove(config))))
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
  // A tree with no file under `plugins/` has nothing to check, which `tsc` reports as TS18003.
  if (
    lines.length > 0 &&
    lines.every((line) => line.includes("error TS18003:"))
  )
    return undefined
  if (code === 0 && lines.length === 0) return undefined
  const rewritten = lines.map((line) =>
    toWork(line, tree, repo)
      .replace(
        missingPackage,
        (_, error: string) => `${error}. ${Messages.importable}`,
      )
      // A relative import names its file as it is, `.ts` included, and TypeScript's hint names `.js` (LOAD-79, SELF-62).
      .replace(/(error TS2835: .* Did you mean '[^']*)\.js'\?$/, "$1.ts'?"),
  )
  return [
    ...rewritten,
    // One line names effect's guide when an error is in a plugin's file (LOAD-31).
    ...(rewritten.some((line) => line.startsWith("work/plugins/"))
      ? [Messages.effectGuide(join(repo, "node_modules/effect/AGENTS.md"))]
      : []),
  ].join("\n")
})

/** A plugin bundled into one CJS file, with its source map and its hash. */
export interface Bundle {
  readonly name: string
  /** The entry file inside the tree. */
  readonly file: string
  /** The exported tree it was bundled from. */
  readonly tree: string
  readonly code: string
  readonly map: Module.SourceMap
  /** SHA-256 of the bundle's text, cut to 12 hex characters (LOAD-48, LOAD-G5). */
  readonly hash: string
  /** The name its frames carry in a stack. */
  readonly filename: string
}

/**
 * The one call of the bundler, so it can be replaced alone (LOAD-11). esbuild runs as a child process of the daemon
 * and writes nothing (LOAD-8). Every package import stays a `require` call (LOAD-9), and the paths in the bundle are
 * relative to the tree, so the same source gives the same text in every tree (LOAD-49).
 */
const build = (tree: string, file: string) =>
  Effect.tryPromise({
    try: () =>
      esbuild.build({
        entryPoints: [file],
        absWorkingDir: tree,
        outdir: tree,
        bundle: true,
        write: false,
        format: "cjs",
        platform: "node",
        target: "node26",
        sourcemap: "external",
        packages: "external",
        // A tsconfig of the tree's own is not read, so its `paths` cannot point a package at a file of the tree. The
        // type-check ignores it too, and the two resolve packages alike (LOAD-9, LOAD-29).
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
        logLevel: "silent",
      }),
    catch: (error) => error,
  }).pipe(
    Effect.map((result) => ({
      code: result.outputFiles.find((output) => output.path.endsWith(".js"))!
        .text,
      map: JSON.parse(
        result.outputFiles.find((output) => output.path.endsWith(".map"))!.text,
      ) as Module.SourceMapPayload,
    })),
  )

/** esbuild's messages, with `work/` paths and the top-level await error rewritten to its fix (LOAD-23). */
const bundleError = (found: Found, error: unknown) => {
  const messages =
    typeof error === "object" &&
    error !== null &&
    Array.isArray((error as esbuild.BuildFailure).errors)
      ? (error as esbuild.BuildFailure).errors
      : []
  if (messages.length === 0) {
    return Messages.notBundled(found.name, [Messages.firstLine(String(error))])
  }
  const at = (message: esbuild.Message) =>
    message.location === null
      ? `work/${found.file}`
      : `work/${message.location.file}:${message.location.line}:${message.location.column + 1}`
  const awaited = messages.find((message) =>
    message.text.startsWith("Top-level await is currently not supported"),
  )
  if (awaited !== undefined)
    return Messages.topLevelAwait(found.name, at(awaited))
  return Messages.notBundled(
    found.name,
    messages.map((message) => `${at(message)}: ${message.text}`),
  )
}

/** Bundles one plugin of a tree. */
export const bundle = (tree: string, found: Found) =>
  build(tree, found.file).pipe(
    Effect.mapError(
      (error) => new LoadError({ message: bundleError(found, error) }),
    ),
    Effect.map(({ code, map }): Bundle => ({
      name: found.name,
      file: found.file,
      tree,
      code,
      map: new Module.SourceMap(map),
      hash: createHash("sha256").update(code).digest("hex").slice(0, 12),
      filename: join(tree, found.file.replace(/\.ts$/, ".bundle.cjs")),
    })),
  )

/** The bundles of the plugin versions that run, by the name their frames carry (LOAD-85). */
const running = new Map<string, Bundle>()

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Rewrites the frames of the given bundles to the source file, line and column, as `work/` paths (LOAD-10). */
const mapFrames = (text: string, bundles: Iterable<Bundle>) => {
  let result = text
  for (const bundle of bundles) {
    if (!result.includes(bundle.filename)) continue
    result = result.replace(
      new RegExp(escape(bundle.filename) + ":(\\d+):(\\d+)", "g"),
      (whole, line: string, column: string) => {
        const entry = bundle.map.findEntry(Number(line) - 1, Number(column) - 1)
        if (!("originalSource" in entry)) return whole
        const source = entry.originalSource.startsWith("file:")
          ? fileURLToPath(entry.originalSource)
          : isAbsolute(entry.originalSource)
            ? entry.originalSource
            : resolve(bundle.tree, entry.originalSource)
        return `work/${relative(bundle.tree, source)}:${entry.originalLine + 1}:${entry.originalColumn + 1}`
      },
    )
  }
  return result
}

/** Rewrites the frames of every running plugin version in a stack (LOAD-86). */
export const mapStack = (text: string) =>
  running.size === 0 ? text : mapFrames(text, running.values())

/**
 * Rewrites the stacks of the errors in a cause in place, so every place that renders it, the log, a notice and the
 * tool error the model reads, gives `work/` paths (LOAD-86).
 */
export const remap = <E>(cause: Cause.Cause<E>): Cause.Cause<E> => {
  if (running.size === 0) return cause
  for (const reason of cause.reasons) {
    const value = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined
    if (value instanceof Error && typeof value.stack === "string") {
      value.stack = mapStack(value.stack)
    }
  }
  return cause
}

/** Keeps a version's source map for as long as the scope it runs in is open (LOAD-85). */
export const register = (bundle: Bundle, scope: Scope.Scope) =>
  Effect.gen(function* () {
    running.set(bundle.filename, bundle)
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        if (running.get(bundle.filename) === bundle) {
          running.delete(bundle.filename)
        }
      }),
    )
  })

const hostRequire = Module.createRequire(import.meta.url)

/** The error of a bundle that threw, down to its last frame inside the bundle (LOAD-41). */
const thrown = (bundle: Bundle, error: unknown) => {
  const lines = (
    error instanceof Error ? (error.stack ?? String(error)) : String(error)
  ).split("\n")
  const last = lines.findLastIndex((line) => line.includes(bundle.filename))
  const kept =
    last === -1
      ? lines.filter((line) => !line.trimStart().startsWith("at "))
      : lines.slice(0, last + 1)
  return mapFrames(kept.join("\n"), [bundle])
}

/**
 * Runs a bundle with `vm.compileFunction`, the host's `require` and a fresh `module` (LOAD-12). Every package the
 * plugin imports is the host's own instance (LOAD-16, LOAD-17). The default export must pass `Plugin.isPlugin`,
 * because a bare Layer passes the type-check (LOAD-6, API-6).
 */
export const run = (bundle: Bundle) =>
  Effect.try({
    try: () => {
      const compiled = vm.compileFunction(
        bundle.code,
        ["require", "module", "exports"],
        {
          filename: bundle.filename,
          // An `import()` of a package goes to the host's own loader, so it gets the host's instance (LOAD-17).
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        },
      )
      const module = { exports: {} as Record<string, unknown> }
      compiled(hostRequire, module, module.exports)
      return module.exports["default"]
    },
    catch: (error) =>
      new LoadError({
        message: Messages.notLoaded(bundle.name, thrown(bundle, error)),
      }),
  }).pipe(
    Effect.flatMap((value) =>
      Plugin.isPlugin(value)
        ? Effect.succeed(value)
        : Effect.fail(
            new LoadError({
              message: Messages.notPlugin(
                bundle.name,
                `work/${bundle.file}`,
                value === undefined && !bundle.file.endsWith("/index.ts"),
              ),
            }),
          ),
    ),
  )

/** A plugin loaded from a tree, as the daemon is handed it. */
export interface Loaded {
  readonly name: string
  readonly plugin: Plugin.Plugin
  readonly bundle: Bundle
}

/**
 * Loads every plugin of an exported tree: each one bundled and run, with no type-check (LOAD-61). A plugin that
 * breaks a name rule, does not bundle, throws or exports no `Plugin` is skipped with its error, and the others load.
 */
export const load = Effect.fnUntraced(function* (
  tree: string,
  bundled: ReadonlySet<string> = new Set(),
) {
  const { found, problems } = yield* discover(tree)
  const loaded: Array<Loaded> = []
  // A plugin with a bundled plugin's name is skipped before its module runs, since the bundled one loads (REC-42).
  const skipped: Array<Skipped> = [
    ...problems.filter(({ name }) => !bundled.has(name)),
    ...[...problems, ...found]
      .filter(({ name }) => bundled.has(name))
      .map(({ name }) => ({ name, message: Messages.bundledName(name) })),
  ]
  for (const plugin of found.filter(({ name }) => !bundled.has(name))) {
    const exit = yield* Effect.exit(
      Effect.flatMap(bundle(tree, plugin), (bundle) =>
        Effect.map(run(bundle), (value) => ({
          name: plugin.name,
          plugin: value,
          bundle,
        })),
      ),
    )
    if (exit._tag === "Success") loaded.push(exit.value)
    else skipped.push({ name: plugin.name, message: messageOf(exit.cause) })
  }
  return { loaded, skipped }
})

/**
 * The checks of a tree that come before any Layer is built, in the order of LOAD-98 and LOAD-53: the plugins' names
 * first, then `tsc`, then each plugin bundled, run and tested with `Plugin.isPlugin`. The result is the errors, and
 * none when the tree passed.
 */
export const check = Effect.fnUntraced(function* (repo: string, tree: string) {
  const { found, problems } = yield* discover(tree)
  if (problems.length > 0) return problems.map(({ message }) => message)
  const typed = yield* typecheck(repo, tree)
  if (typed !== undefined) return [typed]
  const errors: Array<string> = []
  for (const plugin of found) {
    const exit = yield* Effect.exit(Effect.flatMap(bundle(tree, plugin), run))
    if (exit._tag === "Failure") errors.push(messageOf(exit.cause))
  }
  return errors
})
