import {
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import * as RepoLinks from "../../src/daemon/RepoLinks.ts"

const provided = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

it("a move aside never replaces what an earlier one kept, in the same millisecond", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chad-repolinks-"))
  const path = join(repo, "node_modules")
  const saved = `${path}.replaced-2026-11-16T06-28-57-056Z`
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-16T06:28:57.056Z"))
  try {
    for (const text of ["first", "second", "third"]) {
      rmSync(path, { force: true })
      writeFileSync(path, text)
      await provided(RepoLinks.prepare(repo))
    }
  } finally {
    vi.useRealTimers()
  }
  expect(
    [saved, `${saved}-1`, `${saved}-2`].map((file) =>
      readFileSync(file, "utf8"),
    ),
  ).toEqual(["first", "second", "third"])
})

it("a move aside never replaces a link to nothing at its name", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chad-repolinks-"))
  const path = join(repo, "node_modules")
  const saved = `${path}.replaced-2026-11-16T06-28-57-056Z`
  symlinkSync("./missing", saved)
  writeFileSync(path, "owner")
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-16T06:28:57.056Z"))
  try {
    await provided(RepoLinks.prepare(repo))
  } finally {
    vi.useRealTimers()
  }
  expect(readlinkSync(saved)).toBe("./missing")
  expect(readFileSync(`${saved}-1`, "utf8")).toBe("owner")
})
