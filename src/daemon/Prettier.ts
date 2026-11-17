/**
 * Formats the plugin code in `work/` with Prettier, which `chad check` and `chad apply` do before they take their
 * snapshot, so what an apply commits is formatted.
 */
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import * as prettier from "prettier"
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
const style: prettier.Options = { semi: false }

/** The `.ts` files under `plugins/`, as paths from `work`. A link is not followed, and `node_modules` is left out. */
const sources = Effect.fnUntraced(function* (work: string) {
  const fs = yield* FileSystem.FileSystem
  const found: Array<string> = []
  const walk = (relative: string): Effect.Effect<void> =>
    fs.readDirectoryEntries(join(work, relative)).pipe(
      // A `plugins` that is missing or cannot be read holds nothing to format, and the check reports what it lacks.
      Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []),
      Effect.flatMap((entries) =>
        Effect.forEach(
          [...entries].sort((a, b) => (a.name < b.name ? -1 : 1)),
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
  yield* walk("plugins")
  return found
})

/**
 * Formats every `.ts` file under `work/plugins/` with Prettier and the config it finds from the file, or chad's style
 * when there is none, and writes back
 * only a file that changed. A file that does not parse is left as it is for the type-check to report, and any other
 * failure leaves that file as it is and is given back.
 */
export const plugins = Effect.fnUntraced(function* (work: string) {
  const fs = yield* FileSystem.FileSystem
  // The daemon lives long and an edit to a config in `work/` has to reach the next format.
  yield* Effect.promise(() => prettier.clearConfigCache())
  const formatted: Array<string> = []
  const failed: Array<{ readonly file: string; readonly error: string }> = []
  for (const relative of yield* sources(work)) {
    const path = join(work, relative)
    const file = `work/${relative}`
    const result = yield* Effect.gen(function* () {
      const text = yield* fs.readFileString(path)
      const pretty = yield* Effect.tryPromise({
        try: async () =>
          prettier.format(text, {
            ...((await prettier.resolveConfig(path)) ?? style),
            filepath: path,
          }),
        catch: (cause) => cause,
      })
      if (pretty === text) return false
      yield* fs.writeFileString(path, pretty)
      return true
    }).pipe(Effect.result)
    if (result._tag === "Success") {
      if (result.success) formatted.push(file)
      continue
    }
    const error = result.failure
    if (error instanceof SyntaxError) continue
    failed.push({
      file,
      error: Messages.firstLine(
        error instanceof Error ? error.message : String(error),
      ),
    })
  }
  return { formatted, failed } satisfies Formatted as Formatted
})

/** The lines a check or an apply prints about a format. */
export const lines = ({ formatted, failed }: Formatted) => [
  ...(formatted.length > 0 ? [Messages.prettierFormatted(formatted)] : []),
  ...failed.map(({ file, error }) => Messages.prettierFailed(file, error)),
]
