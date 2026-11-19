/**
 * Formats the plugin code in `work/` with Prettier, which `chad check` and `chad apply` do before they take their
 * snapshot, so what an apply commits is formatted.
 */
import { join } from "node:path"
import { Duration, Effect, FileSystem, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Messages from "../Messages.ts"

/** What a format did: the files it rewrote and those it could not format, as `work/` paths. */
export interface Formatted {
  readonly formatted: ReadonlyArray<string>
  readonly failed: ReadonlyArray<{
    readonly file: string
    readonly error: string
  }>
}

/** chad's own style, which the bundled plugins under `examples/` are written in, for a tree with no Prettier config. */
const style = { semi: false }

/**
 * The script of the child process that formats. It reads `{ prettier, style, files }` on stdin and writes one result
 * for each file on descriptor 3, which nothing else writes, so what a config prints on stdout never mixes with the
 * results. It exits once they are written, so a handle a config left open does not keep it alive. A config is resolved
 * apart from the format, so a config that fails is reported and is never taken for a plugin that does not parse. A
 * plugin that does not parse is Prettier's `SyntaxError`, the one with a `loc`.
 */
const script = `
import { Socket } from "node:net"
let input = ""
for await (const chunk of process.stdin) input += chunk
const { prettier, style, files } = JSON.parse(input)
const { format, resolveConfig, resolveConfigFile } = await import(prettier)
const message = (error) => (error instanceof Error ? error.message : String(error))
const results = []
for (const { path, text } of files) {
  let options
  try {
    options = (await resolveConfig(path)) ?? style
  } catch (error) {
    const config = await resolveConfigFile(path).catch(() => null)
    results.push({ _tag: "Failed", error: (config === null ? "" : config + ": ") + message(error) })
    continue
  }
  try {
    results.push({ _tag: "Formatted", text: await format(text, { ...options, filepath: path }) })
  } catch (error) {
    results.push(
      error instanceof SyntaxError && "loc" in error ? { _tag: "Unparsed" } : { _tag: "Failed", error: message(error) },
    )
  }
}
new Socket({ fd: 3, readable: false }).end(JSON.stringify(results), () => process.exit(0))
`

const Results = Schema.fromJsonString(
  Schema.Array(
    Schema.Union([
      Schema.TaggedStruct("Formatted", { text: Schema.String }),
      Schema.TaggedStruct("Unparsed", {}),
      Schema.TaggedStruct("Failed", { error: Schema.String }),
    ]),
  ),
)

/**
 * The `.ts` files under `plugins/`, as paths from `work`. No link is followed, `plugins` itself included, so a format
 * never writes outside `work/`. `node_modules` is left out.
 */
const sources = Effect.fnUntraced(function* (work: string) {
  const fs = yield* FileSystem.FileSystem
  const found: Array<string> = []
  // A missing entry or one that cannot be read holds nothing to format, and the check reports what it lacks.
  const entries = (relative: string) =>
    fs
      .readDirectoryEntries(join(work, relative))
      .pipe(
        Effect.orElseSucceed(
          (): ReadonlyArray<FileSystem.DirectoryEntry> => [],
        ),
      )
  const walk = (relative: string): Effect.Effect<void> =>
    entries(relative).pipe(
      Effect.flatMap((listed) =>
        Effect.forEach(
          [...listed].sort((a, b) => (a.name < b.name ? -1 : 1)),
          ({ name, type }) => {
            const path = `${relative}/${name}`
            if (type === "Directory" && name !== "node_modules")
              return walk(path)
            if (type === "File" && name.endsWith(".ts")) found.push(path)
            return Effect.void
          },
          { discard: true },
        ),
      ),
    )
  const root = (yield* entries(".")).find(({ name }) => name === "plugins")
  if (root?.type === "Directory") yield* walk("plugins")
  return found
})

/**
 * Formats every `.ts` file under `work/plugins/` with Prettier and the config it finds from the file, or chad's style
 * when there is none, and writes back only a file that changed. A file that does not parse is left as it is for the
 * type-check to report, and any other failure, a config that cannot be loaded included, leaves that file as it is and
 * is given back.
 *
 * Prettier runs in a child process of its own each time, so a config that is JavaScript is loaded fresh, as Node's
 * cache of modules would otherwise keep the first version the daemon loaded, and its code runs outside the daemon. A
 * process still running at `deadline` is killed, since the command holds the daemon's queue, and every file is left as
 * it is.
 */
export const plugins = Effect.fnUntraced(function* (
  work: string,
  deadline: Duration.Duration,
) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const relatives = yield* sources(work)
  const formatted: Array<string> = []
  const failed: Array<{ readonly file: string; readonly error: string }> = []
  const toWork = (text: string) =>
    Messages.firstLine(text).replaceAll(`${work}/`, "work/")
  const files: Array<{
    readonly relative: string
    readonly path: string
    readonly text: string
  }> = []
  for (const relative of relatives) {
    const path = join(work, relative)
    const read = yield* Effect.result(fs.readFileString(path))
    if (read._tag === "Failure")
      failed.push({
        file: `work/${relative}`,
        error: toWork(read.failure.message),
      })
    else files.push({ relative, path, text: read.success })
  }
  if (files.length === 0)
    return { formatted: [], failed } satisfies Formatted as Formatted
  const input = JSON.stringify({
    prettier: import.meta.resolve("prettier"),
    style,
    files: files.map(({ path, text }) => ({ path, text })),
  })
  const ran = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          ["--input-type=module", "--eval", script],
          {
            cwd: work,
            stdin: {
              stream: Stream.make(new TextEncoder().encode(input)),
            },
            stdout: "ignore",
            additionalFds: { fd3: { type: "output" } },
            // Nothing in the process needs a clean stop, and a config could ignore a SIGTERM.
            killSignal: "SIGKILL",
          },
        ),
      )
      return yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.getOutputFd(3))),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      )
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: deadline,
      orElse: () =>
        Effect.fail(Messages.prettierTimedOut(Duration.toSeconds(deadline))),
    }),
    Effect.flatMap(([results, stderr, code]) =>
      code === 0
        ? Schema.decodeEffect(Results)(results).pipe(
            Effect.mapError(() => stderr.trim() || "no results"),
          )
        : Effect.fail(stderr.trim() || `exit code ${code}`),
    ),
    Effect.mapError((error) =>
      toWork(typeof error === "string" ? error : error.message),
    ),
    Effect.result,
  )
  for (const [index, { relative, path, text }] of files.entries()) {
    const file = `work/${relative}`
    if (ran._tag === "Failure") {
      failed.push({ file, error: ran.failure })
      continue
    }
    const result = ran.success[index]
    if (result?._tag === "Failed") {
      failed.push({ file, error: toWork(result.error) })
    } else if (result?._tag === "Formatted" && result.text !== text) {
      const written = yield* Effect.result(
        fs.writeFileString(path, result.text),
      )
      if (written._tag === "Failure")
        failed.push({ file, error: toWork(written.failure.message) })
      else formatted.push(file)
    }
  }
  return { formatted, failed } satisfies Formatted as Formatted
})

/** The lines a check or an apply prints about a format. */
export const lines = ({ formatted, failed }: Formatted) => [
  ...(formatted.length > 0 ? [Messages.prettierFormatted(formatted)] : []),
  ...failed.map(({ file, error }) => Messages.prettierFailed(file, error)),
]
