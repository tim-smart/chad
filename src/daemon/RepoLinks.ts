/**
 * The derived entries of `repo/` that let a plugin be type-checked and read: the link to the image's `node_modules`,
 * the link to the bundled plugins' source and `package.json`.
 */
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import * as Errno from "../Errno.ts"
import * as Messages from "../Messages.ts"
import { packageRoot } from "../Paths.ts"
import * as Logger from "./Logger.ts"

/** The image's `node_modules`, which holds this chad's own package as `chad`. */
export const modules = join(packageRoot, "node_modules")

/** The bundled plugins' TypeScript source inside the chad package. */
export const examples = join(packageRoot, "plugins")

/** What `repo/package.json` holds. Without it `tsc` reads a plugin file as CommonJS. */
const manifest = `${JSON.stringify({ type: "module" }, null, 2)}\n`

/**
 * Makes `repo/node_modules` and `repo/examples` again at every boot, so they follow the image. A link found there is
 * replaced without asking, and anything else is moved to `<name>.replaced-<timestamp>` and logged, so nothing the
 * owner kept there is lost. `repo/package.json` is written when it is missing.
 */
export const prepare = Effect.fnUntraced(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem
  // A name is taken by any entry, a link to nothing included, which `exists` would follow and miss.
  const taken = (path: string) =>
    fs
      .exists(path)
      .pipe(
        Effect.flatMap((found) =>
          found ? Effect.succeed(true) : Effect.isSuccess(fs.readLink(path)),
        ),
      )
  yield* fs.makeDirectory(repo, { recursive: true })
  for (const [name, target] of [
    ["node_modules", modules],
    ["examples", examples],
  ] as const) {
    const path = join(repo, name)
    const found = yield* fs.readLink(path).pipe(
      Effect.map((): "link" | "missing" | "other" => "link"),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed("missing" as const)
          : Errno.code(error) === "EINVAL"
            ? Effect.succeed("other" as const)
            : Effect.fail(error),
      ),
    )
    if (found === "link") yield* fs.remove(path)
    if (found === "other") {
      // A name that is taken already, by an earlier move in the same millisecond or by the owner, gets a counter, so
      // the move never replaces what an earlier one kept.
      const stamped = `${path}.replaced-${new Date().toISOString().replace(/[:.]/g, "-")}`
      let to = stamped
      for (let n = 1; yield* taken(to); n++) to = `${stamped}-${n}`
      yield* fs.rename(path, to)
      yield* Logger.event("boot.moved-aside", Messages.movedAside(path, to), {
        path,
        to,
      })
    }
    yield* fs.symlink(target, path)
  }
  const packageJson = join(repo, "package.json")
  if (!(yield* fs.exists(packageJson))) {
    yield* fs.writeFileString(packageJson, manifest)
  }
})
