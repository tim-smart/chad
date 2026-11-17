// The one file of the repository that the image layer's second container is given: its entry in test support with
// everything the entry imports, the built package and effect included.
import { build } from "esbuild"
import { path } from "./repo.ts"

/** The entry the second container runs. */
export const entry = "test/support/second.ts"

/** Bundles the second container's entry into `outfile`, and gives the files that went into it. */
export const bundleFakes = async (outfile: string) => {
  const result = await build({
    entryPoints: [path(entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    logLevel: "warning",
    metafile: true,
    // Some of the bundled packages are CommonJS and ask `require` for Node's own modules. An ES module has none.
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  })
  return Object.keys(result.metafile.inputs)
}
