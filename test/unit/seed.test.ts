// The starter skills a new repo's first commit copies: a start stopped partway through a copy leaves no repo, so the
// next start copies every starter whole, and a `skills` that is a link is left alone so nothing lands outside work/.
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Exit, FileSystem } from "effect"
import { expect, it } from "vitest"
import * as Repo from "../../src/Repo.ts"

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Starter ${name}.\n---\n\n${name} body\n`

/** A starters directory with two skills, the second with a file beside its SKILL.md. */
const starters = (root: string) => {
  const directory = join(root, "starters")
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(directory, name), { recursive: true })
    writeFileSync(join(directory, name, "SKILL.md"), skill(name))
  }
  writeFileSync(join(directory, "beta/ref.md"), "beta reference\n")
  return directory
}

const prepare = (repo: string, from: string, fs?: FileSystem.FileSystem) =>
  Effect.runPromise(
    Repo.prepare(repo, { starters: from }).pipe(
      fs === undefined
        ? (effect) => effect
        : Effect.provideService(FileSystem.FileSystem, fs),
      Effect.exit,
      Effect.provide(NodeServices.layer),
    ),
  )

const committed = (repo: string) =>
  execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "applied", "--", "skills"],
    { cwd: join(repo, "work"), encoding: "utf8" },
  )
    .trim()
    .split("\n")

it("a first start stopped partway through copying a starter leaves no repo, and the next start commits every starter whole", async () => {
  const root = mkdtempSync(join(tmpdir(), "chad-seed-"))
  const repo = join(root, "repo")
  const from = starters(root)
  const fs = await Effect.runPromise(
    FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)),
  )
  // The copy of beta writes half of its SKILL.md and stops, as a kill would.
  const stopping = FileSystem.FileSystem.of({
    ...fs,
    copy: (source, target, options) =>
      source.endsWith("beta")
        ? fs
            .makeDirectory(target, { recursive: true })
            .pipe(
              Effect.andThen(
                fs.writeFileString(join(target, "SKILL.md"), "---\nname: be"),
              ),
              Effect.andThen(Effect.die("killed")),
            )
        : fs.copy(source, target, options),
  })
  expect(Exit.isFailure(await prepare(repo, from, stopping))).toBe(true)
  expect(existsSync(join(repo, "work/.git"))).toBe(false)

  expect(Exit.isSuccess(await prepare(repo, from))).toBe(true)
  expect(committed(repo)).toEqual([
    "skills/alpha/SKILL.md",
    "skills/beta/SKILL.md",
    "skills/beta/ref.md",
  ])
  expect(readFileSync(join(repo, "work/skills/beta/SKILL.md"), "utf8")).toBe(
    skill("beta"),
  )
  expect(existsSync(join(repo, "starters.tmp"))).toBe(false)
})

it("a skills entry that is a link is committed as the link, and no starter is written where it points", async () => {
  const root = mkdtempSync(join(tmpdir(), "chad-seed-"))
  const repo = join(root, "repo")
  const outside = join(root, "outside")
  mkdirSync(outside)
  mkdirSync(join(repo, "work"), { recursive: true })
  symlinkSync(outside, join(repo, "work/skills"))

  expect(Exit.isSuccess(await prepare(repo, starters(root)))).toBe(true)
  expect(readdirSync(outside)).toEqual([])
  expect(committed(repo)).toEqual(["skills"])
})
