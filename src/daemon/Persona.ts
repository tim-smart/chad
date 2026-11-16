/**
 * The persona: `persona.md` at the root of the repo, plain Markdown and optional, which the daemon reads only from an
 * exported tree (docs/spec/14-self-edit-skill.md, SELF-41, REC-11).
 */
import { join } from "node:path"
import { Effect, FileSystem } from "effect"

/** The persona's file, at the root of the repo. */
export const fileName = "persona.md"

/** The persona of a tree. A tree with no `persona.md`, or one that cannot be read as a file, has none (SELF-136). */
export const read = Effect.fnUntraced(function* (tree: string | undefined) {
  if (tree === undefined) return ""
  const fs = yield* FileSystem.FileSystem
  return yield* fs
    .readFileString(join(tree, fileName))
    .pipe(Effect.orElseSucceed(() => ""))
})

/**
 * The persona's part of the system prompt. One that is empty or holds only whitespace adds nothing, and any other goes
 * under its own heading, trimmed (SELF-136).
 */
export const section = (text: string) => {
  const trimmed = text.trim()
  return trimmed === "" ? "" : `\n## Persona\n\n${trimmed}\n`
}
