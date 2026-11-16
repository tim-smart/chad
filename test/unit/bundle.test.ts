// The second container's bundle, checked without an engine, so that a change to
// test support that breaks it fails here and not only in the image layer.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { bundleFakes } from "../support/bundle.ts"

test("the second container's one bundled file parses, and holds neither the daemon's entry nor what only the daemon reads at load", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chad-fakes-"))
  try {
    const outfile = join(directory, "fakes.mjs")
    const inputs = await bundleFakes(outfile)
    // The fakes stand in for the platform and the model. The composition root, and `Version`, whose own
    // `createRequire` clashes with the bundle's banner, are not theirs.
    expect(
      inputs.filter((input) =>
        /^dist\/(daemon\/runDaemon|Version)\.js$/.test(input),
      ),
    ).toEqual([])
    execFileSync(process.execPath, ["--check", outfile], { stdio: "pipe" })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
