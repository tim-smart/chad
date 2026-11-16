// The bundled skills under `skills/` as the CI checks read them (14-self-edit-skill.md, SELF-109 to SELF-115). How a
// check finds what a skill names is the builder's (SELF-G8): a command is a code span or a line of a fenced block that
// starts with `chad `, a path is an absolute path in a code span or a fenced block, an exit code is a list item that
// starts with one or a number after "exit" or "exits" in the prose, and a quoted message is any double-quoted text in
// the prose, with `<name>` for each part that varies. A recipe is a line of a `sh` block.
import { spawn } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, relative } from "node:path"
import { owner, type Ran } from "./cli.ts"
import { path } from "./repo.ts"

export const directory = path("skills")

export interface File {
  /** The file's path under `skills/`, such as `self-edit/plugin.md`. */
  readonly name: string
  readonly text: string
}

/** Every file of every bundled skill. */
export const files = (): ReadonlyArray<File> =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => ({
      name: relative(directory, file),
      text: readFileSync(file, "utf8"),
    }))

const frontMatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/
const fenced = /^```(\w*)\n([\s\S]*?)^```$/gm

/** The fenced blocks of a file, with their language. */
export const blocks = (text: string) =>
  [...text.matchAll(fenced)].map(([, lang, body]) => ({
    lang: lang ?? "",
    body: body ?? "",
  }))

const outsideBlocks = (text: string) =>
  text.replace(frontMatter, "").replace(fenced, "")

const spans = (text: string) =>
  [...outsideBlocks(text).matchAll(/`([^`\n]+)`/g)].map(([, span]) => span!)

/** The prose: no front matter, no fenced block and no code span. */
const prose = (text: string) => outsideBlocks(text).replace(/`[^`\n]+`/g, " ")

/** The code spans and the lines of every fenced block that is not TypeScript or JSON. */
const code = (text: string) => [
  ...spans(text),
  ...blocks(text)
    .filter(({ lang }) => lang !== "ts" && lang !== "json")
    .flatMap(({ body }) => body.split("\n")),
]

/** Every `chad` command line, as words, with a trailing comment dropped. */
export const commands = (text: string): ReadonlyArray<ReadonlyArray<string>> =>
  code(text)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("chad "))
    .map((line) =>
      [...line.replace(/\s+#.*$/, "").matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(
        ([word]) => word,
      ),
    )

/** Every absolute path whose first directory is one of `roots`, cut before its first placeholder. */
export const paths = (text: string, roots: ReadonlySet<string>) =>
  code(text)
    .flatMap((line) => [...line.matchAll(/(?:^|\s)(\/[^\s`'"]+)/g)])
    .map(([, found]) => found!.split("<")[0]!.replace(/[.,:;)]+$/, ""))
    .filter((found) => roots.has(found.split("/")[1]!))

/** Every exit code the prose names. */
export const exitCodes = (text: string): ReadonlyArray<number> =>
  [
    ...prose(text).matchAll(
      /^- (\d+): |\bexits? (\d+)\b|\bexit code (\d+)\b/gm,
    ),
  ].map((match) => Number(match[1] ?? match[2] ?? match[3]))

/** Every double-quoted text in the prose. */
export const quoted = (text: string): ReadonlyArray<string> =>
  [...prose(text).matchAll(/"([^"\n]+)"/g)].map(([, quote]) => quote!)

/** The lines of the `sh` blocks, which are the recipes, with each `<name>` placeholder given a value. */
export const recipes = (text: string): ReadonlyArray<string> =>
  blocks(text)
    .filter(({ lang }) => lang === "sh")
    .flatMap(({ body }) => body.split("\n"))
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .map((line) => line.replace(/<[a-z-]+>/g, "x"))

/** One command of the CLI as its help gives it. */
export interface Help {
  readonly subcommands: ReadonlyArray<string>
  readonly flags: ReadonlyArray<string>
}

/** Reads the subcommands and the flags, global ones included, from the text of `chad <command> --help`. */
export const help = (text: string): Help => {
  const subcommands: Array<string> = []
  const flags: Array<string> = []
  let section = ""
  for (const line of text.split("\n")) {
    if (/^[A-Z][A-Z ]+$/.test(line)) section = line
    else if (line.startsWith("  ") && section === "SUBCOMMANDS")
      subcommands.push(line.trim().split(/\s+/)[0]!)
    else if (line.startsWith("  ") && section.endsWith("FLAGS"))
      flags.push(
        ...[
          ...line
            .trim()
            .split(/\s{2,}/)[0]!
            .matchAll(/--?[A-Za-z][\w-]*/g),
        ].map(([flag]) => flag),
      )
  }
  return { subcommands, flags }
}

/**
 * The whole command tree. `read` gives the help text of each command path it is handed, one level of the tree at a
 * time, so that a caller in a container makes one call per level.
 */
export const tree = (
  read: (paths: ReadonlyArray<ReadonlyArray<string>>) => ReadonlyArray<string>,
): ReadonlyMap<string, Help> => {
  const all = new Map<string, Help>()
  let level: ReadonlyArray<ReadonlyArray<string>> = [[]]
  while (level.length > 0) {
    const texts = read(level)
    const next: Array<ReadonlyArray<string>> = []
    level.forEach((at, index) => {
      const found = help(texts[index]!)
      all.set(at.join(" "), found)
      next.push(...found.subcommands.map((name) => [...at, name]))
    })
    level = next
  }
  return all
}

/**
 * What is wrong with one command line against the tree: a flag its command does not take. The words after the first
 * that is no subcommand are arguments, and `--` ends what chad reads.
 */
export const problems = (
  all: ReadonlyMap<string, Help>,
  words: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const found: Array<string> = []
  let at: Array<string> = []
  let positional = false
  for (const word of words.slice(1)) {
    if (word === "--") break
    const command = all.get(at.join(" "))!
    if (word.startsWith("-")) {
      const flag = word.split("=")[0]!
      if (!command.flags.includes(flag))
        found.push(`chad ${at.join(" ")} takes no ${flag}: ${words.join(" ")}`)
    } else if (!positional && command.subcommands.includes(word))
      at = [...at, word]
    else {
      if (!positional && command.subcommands.length > 0)
        found.push(
          `chad ${[...at, word].join(" ")} is no command: ${words.join(" ")}`,
        )
      positional = true
    }
  }
  return found
}

const gap = "\u0000"

/**
 * The string literals and template literals of a TypeScript source, each `${...}` of a template as a gap. A template
 * inside a gap is one of its own.
 */
export const templates = (source: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  let at = 0
  const quotedString = (close: string) => {
    let text = ""
    at++
    while (at < source.length && source[at] !== close) {
      if (source[at] === "\\") {
        text += source[at + 1]
        at += 2
      } else text += source[at++]
    }
    at++
    return text
  }
  const template = () => {
    let text = ""
    at++
    while (at < source.length && source[at] !== "`") {
      if (source[at] === "\\") {
        text += source[at + 1]
        at += 2
      } else if (source.startsWith("${", at)) {
        at += 2
        expression("}")
        text += gap
      } else text += source[at++]
    }
    at++
    return text
  }
  // Reads code up to the closing character, collecting every literal in it.
  const expression = (close: string | undefined) => {
    let depth = 0
    while (at < source.length) {
      const char = source[at]!
      if (source.startsWith("//", at)) at = source.indexOf("\n", at)
      else if (source.startsWith("/*", at)) at = source.indexOf("*/", at) + 2
      else if (char === '"' || char === "'") found.push(quotedString(char))
      else if (char === "`") found.push(template())
      else if (char === "{") {
        depth++
        at++
      } else if (char === "}" && depth === 0 && close === "}") {
        at++
        return
      } else {
        if (char === "}") depth--
        at++
      }
      if (at < 0) return
    }
  }
  expression(undefined)
  return found
}

/**
 * Whether a quoted message can be part of what a template gives: some text matches the quote, with each `<name>` as
 * any text, and is part of a text that matches the template, with each gap as any text.
 */
export const fits = (quote: string, template: string): boolean => {
  // The gaps around the quote stand for the rest of the template's text.
  const q = gap + quote.replace(/<[^<>]+>/g, gap) + gap
  const t = template
  // matched[j] holds whether q from i on matches t from j on, for the row i being worked out.
  let next: Array<boolean> = Array.from({ length: t.length + 1 }, (_, j) =>
    t
      .slice(j)
      .split("")
      .every((char) => char === gap),
  )
  for (let i = q.length - 1; i >= 0; i--) {
    const row: Array<boolean> = Array(t.length + 1).fill(false)
    for (let j = t.length; j >= 0; j--) {
      const a = q[i]!
      const b = t[j]
      row[j] =
        (a === gap && (next[j]! || (b !== undefined && row[j + 1]!))) ||
        (b === gap && (row[j + 1]! || next[j]!)) ||
        (b !== undefined && a !== gap && b !== gap && a === b && next[j + 1]!)
    }
    next = row
  }
  return next[0]!
}

/** Whether a quoted message fits one of the templates. */
export const inMessages = (
  quote: string,
  all: ReadonlyArray<string>,
): boolean => {
  const word = quote
    .replace(/<[^<>]+>/g, " ")
    .split(/[^A-Za-z]+/)
    .reduce((a, b) => (b.length > a.length ? b : a), "")
  return all.some(
    (template) => template.includes(word) && fits(quote, template),
  )
}

/**
 * A directory for PATH that holds a `chad` that runs this checkout's CLI and, for each of `fakes`, a command that
 * reads its standard input, prints its own name and nothing it was given, and exits 0.
 */
export const toolbox = (at: string, fakes: ReadonlyArray<string>): string => {
  mkdirSync(at, { recursive: true })
  const write = (name: string, script: string) => {
    writeFileSync(join(at, name), script)
    chmodSync(join(at, name), 0o755)
  }
  write(
    "chad",
    `#!/bin/sh\nexec "${process.execPath}" "${path("bin/chad.js")}" "$@"\n`,
  )
  for (const name of fakes)
    write(name, `#!/bin/sh\ncat > /dev/null\necho "${name} ran"\n`)
  return at
}

/** Runs a recipe with `sh -c`, with the toolbox first on PATH. */
export const shell = (
  recipe: string,
  bin: string,
  env: Readonly<Record<string, string | undefined>>,
  input?: string,
): Promise<Ran & { readonly recipe: string }> =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", recipe], {
      env: owner({ ...env, PATH: `${bin}:${process.env["PATH"]}` }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.end(input)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("close", (code) => resolve({ recipe, stdout, stderr, code }))
  })
