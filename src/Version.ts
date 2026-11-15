import { readFileSync } from "node:fs"

/** The chad version, which is the version of the package this file is part of. */
export const version: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version
