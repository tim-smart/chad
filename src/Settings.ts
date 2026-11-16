/**
 * `chad.json`, the file in the repo that holds each plugin's settings and its on/off switch
 * (docs/spec/11-settings.md): the checks an apply makes on it, the lenient read a boot makes, the `${NAME}` expander,
 * and the ConfigProvider that answers a plugin's `Config` reads and records what it asked for. All of it is pure
 * code apart from `read` and the lookup the expander is handed.
 */
import { join } from "node:path"
import {
  ConfigProvider,
  Data,
  Effect,
  FileSystem,
  Option,
  Predicate,
} from "effect"
import * as Errno from "./Errno.ts"
import * as Messages from "./Messages.ts"

/** The file's name at the root of the repo (SET-1). */
export const fileName = "chad.json"

/** One plugin's entry: both keys are optional (SET-3). */
export interface Entry {
  readonly enabled?: boolean
  readonly settings?: Readonly<Record<string, unknown>>
}

/** The file as chad uses it, keyed by plugin name (SET-2). */
export interface File {
  readonly plugins: Readonly<Record<string, Entry>>
}

/** A missing file is the same as an empty one (SET-6). */
export const empty: File = { plugins: {} }

/**
 * The text of a tree's `chad.json`, `undefined` when there is none. A file that cannot be read gives the error, which
 * a boot treats as a file that cannot be parsed.
 */
export const read = (
  tree: string,
): Effect.Effect<
  | { readonly _tag: "Text"; readonly text: string | undefined }
  | { readonly _tag: "Unreadable"; readonly error: string },
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(join(tree, fileName)).pipe(
      Effect.map((text) => ({ _tag: "Text" as const, text })),
      Effect.catch((error) =>
        Effect.succeed(
          Errno.code(error) === "ENOENT"
            ? { _tag: "Text" as const, text: undefined }
            : { _tag: "Unreadable" as const, error: Errno.code(error) },
        ),
      ),
    )
  })

const entryKeys: ReadonlySet<string> = new Set(["enabled", "settings"])

const parse = (
  text: string,
):
  | { readonly _tag: "Parsed"; readonly value: unknown }
  | { readonly _tag: "Unparsable"; readonly error: string } => {
  try {
    return { _tag: "Parsed", value: JSON.parse(text) }
  } catch (error) {
    return { _tag: "Unparsable", error: (error as Error).message }
  }
}

/**
 * The checks an apply and `chad check` make on the file, which is `undefined` when it is missing. `known` is every
 * plugin name, bundled or in the repo. The result is the file and every error, none when it passed (SET-49 to SET-53,
 * SET-87 to SET-89).
 */
export const validate = (
  text: string | undefined,
  known: ReadonlySet<string>,
): { readonly file: File; readonly errors: ReadonlyArray<string> } => {
  if (text === undefined) return { file: empty, errors: [] }
  const parsed = parse(text)
  if (parsed._tag === "Unparsable")
    return { file: empty, errors: [Messages.settingsNotJson(parsed.error)] }
  const value = parsed.value
  if (!Predicate.isObject(value))
    return { file: empty, errors: [Messages.settingsNotObject] }
  const errors: Array<string> = []
  for (const key of Object.keys(value)) {
    if (key !== "plugins") errors.push(Messages.settingsTopKey(key))
  }
  const plugins = value["plugins"]
  if (plugins === undefined) return { file: empty, errors }
  if (!Predicate.isObject(plugins)) {
    errors.push(Messages.settingsPluginsNotObject)
    return { file: empty, errors }
  }
  const entries: Record<string, Entry> = {}
  for (const [name, entry] of Object.entries(plugins)) {
    if (!known.has(name)) errors.push(Messages.settingsUnknownPlugin(name))
    if (!Predicate.isObject(entry)) {
      errors.push(Messages.settingsEntryNotObject(name))
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!entryKeys.has(key)) errors.push(Messages.settingsEntryKey(name, key))
    }
    const { enabled, settings } = entry
    if (enabled !== undefined && !Predicate.isBoolean(enabled))
      errors.push(Messages.settingsEnabled(name))
    if (settings !== undefined && !Predicate.isObject(settings))
      errors.push(Messages.settingsSettings(name))
    entries[name] = {
      ...(Predicate.isBoolean(enabled) ? { enabled } : {}),
      ...(Predicate.isObject(settings) ? { settings } : {}),
    }
  }
  return { file: { plugins: entries }, errors }
}

/**
 * The read a boot makes, which nothing in the file can stop. With no `known`, an entry is kept whatever it names,
 * which is the read of safe mode and of the file an apply already checked. A file that cannot be parsed counts as empty. An unknown
 * key, an entry that names no plugin, a `plugins` that is not an object, an entry that is not an object or whose
 * `enabled` is not a boolean, and a `settings` that is not an object are each ignored, and the rest of the file is
 * used. `ignored` lists each one by its path in the file (SET-57 to SET-59, SET-90 to SET-92, SET-97).
 */
export const lenient = (
  text: string | undefined,
  known?: ReadonlySet<string>,
): {
  readonly file: File
  readonly unparsable: string | undefined
  readonly ignored: ReadonlyArray<string>
} => {
  if (text === undefined)
    return { file: empty, unparsable: undefined, ignored: [] }
  const parsed = parse(text)
  if (parsed._tag === "Unparsable")
    return { file: empty, unparsable: parsed.error, ignored: [] }
  const value = parsed.value
  // A file whose top level is not an object holds no key that could be used, so it counts as one that cannot be parsed.
  if (!Predicate.isObject(value))
    return {
      file: empty,
      unparsable: Messages.settingsNotObject,
      ignored: [],
    }
  const ignored: Array<string> = Object.keys(value).filter(
    (key) => key !== "plugins",
  )
  const plugins = value["plugins"]
  if (plugins === undefined)
    return { file: empty, unparsable: undefined, ignored }
  if (!Predicate.isObject(plugins))
    return {
      file: empty,
      unparsable: undefined,
      ignored: [...ignored, "plugins"],
    }
  const entries: Record<string, Entry> = {}
  for (const [name, entry] of Object.entries(plugins)) {
    const path = `plugins.${name}`
    if (
      (known !== undefined && !known.has(name)) ||
      !Predicate.isObject(entry) ||
      (entry["enabled"] !== undefined && !Predicate.isBoolean(entry["enabled"]))
    ) {
      ignored.push(path)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!entryKeys.has(key)) ignored.push(`${path}.${key}`)
    }
    const { enabled, settings } = entry
    if (settings !== undefined && !Predicate.isObject(settings))
      ignored.push(`${path}.settings`)
    entries[name] = {
      ...(Predicate.isBoolean(enabled) ? { enabled } : {}),
      ...(Predicate.isObject(settings) ? { settings } : {}),
    }
  }
  return { file: { plugins: entries }, unparsable: undefined, ignored }
}

/** The plugins the file turns off with `"enabled": false` (SET-34). */
export const off = (file: File): ReadonlySet<string> =>
  new Set(
    Object.entries(file.plugins)
      .filter(([, entry]) => entry.enabled === false)
      .map(([name]) => name),
  )

/** A plugin's `settings` object, which is empty with no entry or no key (SET-4). */
export const settingsOf = (
  file: File,
  name: string,
): Readonly<Record<string, unknown>> =>
  (Object.hasOwn(file.plugins, name)
    ? file.plugins[name]?.settings
    : undefined) ?? {}

/** A JSON value with the keys of every object in order, so two that differ only in key order compare equal. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : Predicate.isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value

/** Whether two `settings` objects are the same before expansion, which says whether the settings changed (SET-62). */
export const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a ?? {})) === JSON.stringify(canonical(b ?? {}))

// The expander: chad's copy of clanka's pattern and the code around it, with the lookup replaced by chad's own
// (SET-27 to SET-30).

const variablePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** A `${NAME}` with no default that resolves nowhere (SET-22). */
export class MissingVariable extends Data.TaggedError("MissingVariable")<{
  readonly variable: string
}> {
  override get message() {
    return Messages.settingUnresolved(this.variable)
  }
}

/** Where a name resolved. */
export type From = "store" | "env"

/** The secret store first, then process env (SET-20). */
export type Lookup<E, R> = (
  name: string,
) => Effect.Effect<
  Option.Option<{ readonly value: string; readonly from: From }>,
  E,
  R
>

/** Where a setting's value came from, which the listing shows in place of the value (SET-71, SET-93). */
export type Source =
  | { readonly from: "file" }
  | { readonly from: "default" }
  | {
      readonly from: "store" | "env" | "inline"
      readonly name: string
    }

/** One string expanded, with where each name in it resolved. */
export const expandString = Effect.fnUntraced(function* <E, R>(
  text: string,
  lookup: Lookup<E, R>,
) {
  let result = ""
  let last = 0
  const names: Array<Source> = []
  for (const match of text.matchAll(variablePattern)) {
    const [whole, name, fallback] = match
    const value = Option.filter(yield* lookup(name!), ({ value }) =>
      fallback === undefined ? true : value !== "",
    )
    if (Option.isNone(value) && fallback === undefined) {
      return yield* new MissingVariable({ variable: name! })
    }
    names.push(
      Option.isSome(value)
        ? { from: value.value.from, name: name! }
        : { from: "inline", name: name! },
    )
    result +=
      text.slice(last, match.index) +
      Option.match(value, {
        onNone: () => fallback!,
        onSome: ({ value }) => value,
      })
    last = match.index + whole.length
  }
  // A string that is one name and nothing else came from that name alone, and one with text around its names from the
  // file as well.
  const alone =
    names.length === 1 && /^\$\{[^}]*\}$/.test(text) ? names : undefined
  return {
    text: result + text.slice(last),
    sources:
      alone ??
      (names.length === 0 ? [] : [{ from: "file" } as const, ...names]),
  }
})

/**
 * A path in a plugin's settings, as the listing names it: its keys joined with dots. An array is one key, since it is
 * read whole (SET-13), so the path stops before the first index.
 */
export const keyOf = (path: ReadonlyArray<string | number>): string => {
  const index = path.findIndex((part) => typeof part === "number")
  return (index === -1 ? path : path.slice(0, index)).join(".")
}

/** A plugin's settings after expansion, with the sources of each string that named something. */
export interface Expanded {
  readonly value: unknown
  readonly sources: ReadonlyMap<string, ReadonlyArray<Source>>
}

/** Expands `${NAME}` and `${NAME:-default}` in every string of a plugin's settings, in one pass (SET-19, SET-29). */
export const expand = <E, R>(
  settings: unknown,
  lookup: Lookup<E, R>,
): Effect.Effect<Expanded, MissingVariable | E, R> =>
  Effect.gen(function* () {
    const sources = new Map<string, ReadonlyArray<Source>>()
    const walk = (
      value: unknown,
      path: ReadonlyArray<string | number>,
    ): Effect.Effect<unknown, MissingVariable | E, R> =>
      Effect.gen(function* () {
        if (Predicate.isString(value)) {
          const expanded = yield* expandString(value, lookup)
          if (expanded.sources.length > 0) {
            const key = keyOf(path)
            sources.set(key, [...(sources.get(key) ?? []), ...expanded.sources])
          }
          return expanded.text
        }
        if (Array.isArray(value)) {
          const out: Array<unknown> = []
          for (const [index, item] of value.entries())
            out.push(yield* walk(item, [...path, index]))
          return out
        }
        if (Predicate.isObject(value)) {
          const out: Record<string, unknown> = {}
          for (const [key, item] of Object.entries(value))
            out[key] = yield* walk(item, [...path, key])
          return out
        }
        return value
      })
    return { value: yield* walk(settings ?? {}, []), sources }
  })

/** Every name a plugin's settings refer to with `${NAME}`, before expansion (SET-26). */
export const names = (settings: unknown): ReadonlySet<string> => {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (Predicate.isString(value)) {
      for (const [, name] of value.matchAll(variablePattern)) found.add(name!)
    } else if (Array.isArray(value)) value.forEach(walk)
    else if (Predicate.isObject(value)) Object.values(value).forEach(walk)
  }
  walk(settings)
  return found
}

/** One key the listing shows: its path, where its value came from, and whether it was read at load or at call time (SET-94). */
export interface Item {
  readonly key: string
  readonly sources: ReadonlyArray<Source>
  readonly at: "load" | "call"
}

/** Every key at full path depth, a nested one by its whole path and an array as one key (SET-68). */
const leaves = (
  value: unknown,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const children: ReadonlyArray<readonly [string, unknown]> =
    Predicate.isObject(value) ? Object.entries(value) : []
  if (children.length === 0) return path.length === 0 ? [] : [keyOf(path)]
  return children.flatMap(([key, child]) => leaves(child, [...path, key]))
}

/** A plugin's provider and what it recorded. */
export interface Recorder {
  /** The provider: `ConfigProvider.fromUnknown` over the expanded settings and nothing else (SET-11, SET-12). */
  readonly provider: ConfigProvider.ConfigProvider
  /** Marks the end of the load. A read after it is a read at call time (SET-70). */
  readonly loaded: () => void
  /** The keys asked for, in the order first asked, with no value (SET-65, SET-67, SET-71, SET-72). */
  readonly items: () => ReadonlyArray<Item>
  /** The keys in the settings that were not read while loading (SET-68). */
  readonly unread: () => ReadonlyArray<string>
}

/**
 * The provider of one plugin's version, which records each key it is asked for: a key with a value comes from the
 * file or from the names its string held, and a key with none took its default, since the load got past it.
 */
export const recorder = (expanded: Expanded): Recorder => {
  const base = ConfigProvider.fromUnknown(expanded.value)
  let phase: "load" | "call" = "load"
  const seen = new Map<
    string,
    { readonly sources: ReadonlyArray<Source>; load: boolean }
  >()
  const provider = ConfigProvider.make((path) =>
    Effect.tap(base.load(path), (node) =>
      Effect.sync(() => {
        // An object asked for whole is not a key, and its keys are recorded as they are read.
        if (node?._tag === "Record") return
        const key = keyOf(path)
        const known = seen.get(key)
        if (known !== undefined) {
          if (phase === "load") known.load = true
          return
        }
        seen.set(key, {
          sources:
            node === undefined
              ? [{ from: "default" }]
              : (expanded.sources.get(key) ?? [{ from: "file" }]),
          load: phase === "load",
        })
      }),
    ),
  )
  return {
    provider,
    loaded: () => {
      phase = "call"
    },
    items: () =>
      [...seen].map(([key, { sources, load }]) => ({
        key,
        sources,
        at: load ? "load" : "call",
      })),
    unread: () =>
      leaves(expanded.value).filter((key) => seen.get(key)?.load !== true),
  }
}
