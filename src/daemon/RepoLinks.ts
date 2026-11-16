/**
 * The derived entries of `repo/` that let a plugin be type-checked and read: the link to the image's `node_modules`,
 * the link to the bundled plugins' source and `package.json` (LOAD-26, IMG-44 to IMG-46).
 */
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, FileSystem } from "effect"
import * as Errno from "../Errno.ts"
import * as Messages from "../Messages.ts"
import * as Logger from "./Logger.ts"

/** The image's `node_modules`, which holds this chad's own package as `chad` (IMG-49). */
export const modules = fileURLToPath(
  new URL("../../node_modules", import.meta.url),
)

/** The bundled plugins' TypeScript source inside the chad package (IMG-45, IMG-51). */
export const examples = fileURLToPath(new URL("../../plugins", import.meta.url))

/** What `repo/package.json` holds. Without it `tsc` reads a plugin file as CommonJS (LOAD-26). */
const manifest = `${JSON.stringify({ type: "module" }, null, 2)}\n`

/**
 * Makes `repo/node_modules` and `repo/examples` again at every boot, so they follow the image. A link found there is
 * replaced without asking, and anything else is moved to `<name>.replaced-<timestamp>` and logged, so nothing the
 * owner kept there is lost (IMG-46, FAIL-289). `repo/package.json` is written when it is missing.
 */
export const prepare = Effect.fnUntraced(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem
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
      const to = `${path}.replaced-${new Date().toISOString().replace(/[:.]/g, "-")}`
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
