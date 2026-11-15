import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

/** The chad version, which is the version of the package this file is part of. */
export const version: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version

/**
 * The version of the effect package that is installed beside chad, which is the one the daemon runs and plugins are
 * given. It gives nothing where no effect is installed, as for a copy of the bundled CLI by itself.
 */
export const effect = (): string | undefined => {
  try {
    const manifest = createRequire(import.meta.url).resolve(
      "effect/package.json",
    )
    return JSON.parse(readFileSync(manifest, "utf8")).version
  } catch {
    return undefined
  }
}
