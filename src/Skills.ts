/**
 * Skills: `skills/<name>/SKILL.md` in the repo and in the image's bundled directory.
 * chad scans them itself and hands clanka the list, so a skill reaches a session only through an apply.
 */
import { createHash } from "node:crypto"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, FileSystem, Schema } from "effect"
import { Yaml } from "effect/encoding"
import * as Messages from "./Messages.ts"

/** The bundled skills, `skills/` at the root of the package, next to `dist/`: `/opt/chad/skills` in the image. */
export const bundledDirectory = fileURLToPath(
  new URL("../skills", import.meta.url),
)

/** The skill file in a skill's directory. */
export const fileName = "SKILL.md"

/** A skill name is made of lower-case letters, digits and hyphens. */
export const validName = (name: string): boolean => /^[a-z0-9-]+$/.test(name)

/** A skill whose `SKILL.md` passed the checks. Its name is its directory's. */
export interface Skill {
  readonly name: string
  readonly description: string
  /** The whole of `SKILL.md`. */
  readonly text: string
}

/** A skill that failed the checks, by its directory, and what is wrong with its file. */
export interface Bad {
  readonly name: string
  readonly problem: string
}

/** The skills under one `skills/` directory, in the order of their names. */
export interface Found {
  readonly skills: ReadonlyArray<Skill>
  readonly bad: ReadonlyArray<Bad>
}

export const none: Found = { skills: [], bad: [] }

const frontMatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

const Fields = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.Unknown),
})

const filled = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

/**
 * Checks one `SKILL.md`: front matter as clanka reads it, a name and a description that are not empty, and a name that is
 * the directory's. As a name is its directory's, two skills never share one.
 */
export const parse = (dir: string, text: string): Skill | Bad => {
  const match = frontMatter.exec(text)
  const fields = (() => {
    if (match === null) return undefined
    try {
      return Schema.decodeUnknownOption(Fields)(Yaml.parse(match[1]!))
    } catch {
      return undefined
    }
  })()
  if (fields === undefined || fields._tag === "None") {
    return { name: dir, problem: Messages.skillProblems.noFrontMatter(dir) }
  }
  const name = filled(fields.value.name)
  if (name === undefined) {
    return { name: dir, problem: Messages.skillProblems.noName(dir) }
  }
  const description = filled(fields.value.description)
  if (description === undefined) {
    return { name: dir, problem: Messages.skillProblems.noDescription }
  }
  if (name !== dir) {
    return { name: dir, problem: Messages.skillProblems.otherName(name, dir) }
  }
  return { name, description, text }
}

/**
 * The skills of a `skills/` directory: each directory in it that holds a `SKILL.md`. Anything else is not a skill, and a
 * directory that is missing or cannot be read holds none. A skill with a file that resolves outside the tree the directory
 * is in, or to nothing, through its own link or a linked directory, fails the checks. The model reads a skill's other
 * files through `repo/live`, so this holds for every file of the skill and not only its `SKILL.md`: a skill only ever
 * holds what was applied.
 */
export const scan = Effect.fnUntraced(function* (
  directory: string | undefined,
) {
  if (directory === undefined) return none
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): Array<string> => []))
  const root = yield* fs
    .realPath(dirname(directory))
    .pipe(Effect.orElseSucceed(() => dirname(directory)))
  const realInside = (path: string) =>
    fs.realPath(path).pipe(
      Effect.map((real) => (real.startsWith(root + sep) ? real : undefined)),
      Effect.orElseSucceed(() => undefined),
    )
  const inside = (path: string) =>
    Effect.map(realInside(path), (real) => real !== undefined)
  /**
   * The paths under a skill's directory that resolve outside the tree or to nothing. Each entry is checked before the
   * walk goes into it, and each real directory is walked once, so a link back to a directory already walked ends the
   * walk there: what is under it was checked on the first visit, as a link resolves to the same file whatever path
   * reaches it.
   */
  const escapingUnder = Effect.fnUntraced(function* (skill: string) {
    const escaping: Array<string> = []
    const start = yield* realInside(skill)
    if (start === undefined) return escaping
    const visited = new Set([start])
    const walk: (relative: string) => Effect.Effect<void> = Effect.fnUntraced(
      function* (relative: string) {
        const names = yield* fs
          .readDirectory(join(skill, relative))
          .pipe(Effect.orElseSucceed((): Array<string> => []))
        for (const name of [...names].sort()) {
          const path = relative === "" ? name : join(relative, name)
          const real = yield* realInside(join(skill, path))
          if (real === undefined) {
            escaping.push(path)
            continue
          }
          const info = yield* Effect.option(fs.stat(real))
          if (
            info._tag === "Some" &&
            info.value.type === "Directory" &&
            !visited.has(real)
          ) {
            visited.add(real)
            yield* walk(path)
          }
        }
      },
    )
    yield* walk("")
    return escaping
  })
  const skills: Array<Skill> = []
  const bad: Array<Bad> = []
  for (const entry of [...entries].sort()) {
    const file = join(directory, entry, fileName)
    const info = yield* Effect.option(fs.stat(file))
    if (info._tag === "None" || info.value.type !== "File") continue
    if (!(yield* inside(file))) {
      bad.push({ name: entry, problem: Messages.skillProblems.outside })
      continue
    }
    const escaping = yield* escapingUnder(join(directory, entry))
    if (escaping.length > 0) {
      bad.push({
        name: entry,
        problem: Messages.skillProblems.outsideFiles(escaping),
      })
      continue
    }
    const read = yield* Effect.result(fs.readFileString(file))
    const parsed =
      read._tag === "Failure"
        ? {
            name: entry,
            problem: Messages.skillProblems.unreadable(read.failure.message),
          }
        : parse(entry, read.success)
    if ("problem" in parsed) bad.push(parsed)
    else skills.push(parsed)
  }
  return { skills, bad } satisfies Found
})

/** The errors a check or an apply prints for a tree's skills, each naming the file. */
export const check = Effect.fnUntraced(function* (tree: string) {
  const found = yield* scan(join(tree, "skills"))
  return {
    found,
    errors: found.bad.map(({ name, problem }) =>
      Messages.skillRefused(name, problem),
    ),
  }
})

/** The repo skills that hide a bundled skill of the same name. */
export const hiding = (repo: Found, bundled: Found): ReadonlyArray<string> => {
  const names = new Set(bundled.skills.map(({ name }) => name))
  return repo.skills.map(({ name }) => name).filter((name) => names.has(name))
}

/** The repo skills an apply adds, changes and removes, from the paths its commit changed. */
export const changes = (
  before: Found,
  after: Found,
  paths: ReadonlyArray<string>,
) => {
  const old = new Set(before.skills.map(({ name }) => name))
  const now = new Set(after.skills.map(({ name }) => name))
  const touched = new Set(
    paths.flatMap((path) => {
      const [top, name] = path.split("/")
      return top === "skills" && name !== undefined ? [name] : []
    }),
  )
  return {
    added: [...now].filter((name) => !old.has(name)),
    changed: [...now].filter((name) => old.has(name) && touched.has(name)),
    removed: [...old].filter((name) => !now.has(name)),
  }
}

/** A skill as clanka takes it in the `skills` option. */
export interface Provided {
  readonly name: string
  readonly description: string
  readonly content: string
}

/**
 * The list a session's Agent is built with. A repo skill wins over a bundled one of the same name, and safe mode lists
 * the bundled skills alone. Each one's content ends with where its files are: a repo
 * skill's through `repo/live`, unresolved, and a bundled one's in the image, and with where an edit goes.
 */
export const provided = (options: {
  readonly repo: Found | undefined
  readonly bundled: Found
  readonly bundledDirectory: string
  /** The repo directory on the volume, `repo/`. */
  readonly repoDirectory: string
}): ReadonlyArray<Provided> => {
  const work = (name: string) =>
    join(options.repoDirectory, "work/skills", name)
  const repo = (options.repo?.skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description,
    content: `${skill.text.trimEnd()}\n\n${Messages.repoSkillWhere(join(options.repoDirectory, "live/skills", skill.name), work(skill.name))}\n`,
  }))
  const taken = new Set(repo.map(({ name }) => name))
  const bundled = options.bundled.skills
    .filter(({ name }) => !taken.has(name))
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: `${skill.text.trimEnd()}\n\n${Messages.bundledSkillWhere(join(options.bundledDirectory, skill.name), work(skill.name))}\n`,
    }))
  return [...repo, ...bundled].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
}

/**
 * A bundled skill's hash: SHA-256 over the sorted relative paths of the files in its directory and their contents.
 */
export const hash = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory(directory, { recursive: true })
  const digest = createHash("sha256")
  for (const path of [...entries].sort()) {
    const info = yield* fs.stat(join(directory, path))
    if (info.type !== "File") continue
    digest.update(`${path}\0`)
    digest.update(yield* fs.readFile(join(directory, path)))
    digest.update("\0")
  }
  return digest.digest("hex")
})

/** Where the hashes are kept. */
export const hashesFile = (data: string) =>
  join(data, "state/bundled-skills.json")

const Hashes = Schema.Record(Schema.String, Schema.String)

/**
 * Stores the bundled skills' hashes and gives the skills whose hash changed since the stored one while a repo skill
 * hides them. A file that is missing or cannot be read is a first boot, which gives none. The file is written to a
 * temporary name and renamed.
 */
export const bundledChanged = Effect.fnUntraced(function* (options: {
  readonly data: string
  readonly bundled: Found
  readonly bundledDirectory: string
  readonly hiding: ReadonlyArray<string>
}) {
  const fs = yield* FileSystem.FileSystem
  const target = hashesFile(options.data)
  const stored = yield* fs.readFileString(target).pipe(
    Effect.flatMap((text) =>
      Effect.try(() => JSON.parse(text) as unknown).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Hashes)),
      ),
    ),
    Effect.option,
  )
  const hashes: Record<string, string> = {}
  for (const { name } of options.bundled.skills) {
    hashes[name] = yield* hash(join(options.bundledDirectory, name))
  }
  const temporary = `${target}.${process.pid}.tmp`
  yield* fs.makeDirectory(join(options.data, "state"), { recursive: true })
  yield* fs.writeFileString(temporary, `${JSON.stringify(hashes)}\n`)
  yield* fs.rename(temporary, target)
  if (stored._tag === "None") return []
  const before = stored.value
  return options.hiding.filter(
    (name) =>
      before[name] !== undefined &&
      hashes[name] !== undefined &&
      before[name] !== hashes[name],
  )
})

/** The key of a skipped skill's notice. */
export const skippedKey = (name: string) => `skill-skipped:${name}`

/**
 * What `chad skill new` writes: front matter with the name and an empty description, which a check refuses until the
 * agent says when to read the skill, and a line on what the body holds. The name is quoted, as YAML reads
 * a name such as `123` or `true` as something other than a string.
 */
export const template = (name: string) =>
  `---\nname: "${name}"\ndescription:\n---\n\n${Messages.skillBody}\n`
