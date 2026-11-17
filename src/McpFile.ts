/**
 * `mcp.json` at the root of the repo: its read, its checks and its expansion into the
 * config clanka's `McpServers.layer` takes. chad reads this one file itself, with the keys and the `${NAME}` rules of
 * clanka's loader, and never the files `McpConfig.load` also reads.
 */
import { join, isAbsolute } from "node:path"
import type * as McpServers from "clanka/McpServers"
import { Duration, Effect, FileSystem, Option, Redacted, Schema } from "effect"
import * as Errno from "./Errno.ts"
import * as Messages from "./Messages.ts"
import * as Settings from "./Settings.ts"

export const fileName = "mcp.json"

/** The keys clanka's loader reads, before expansion. Any other key is dropped, as clanka drops it. */
const Entry = Schema.Struct({
  type: Schema.optionalKey(Schema.Literals(["stdio", "http", "sse"])),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  connectTimeout: Schema.optionalKey(Schema.Number),
  callTimeout: Schema.optionalKey(Schema.Number),
})
type Entry = typeof Entry.Type

const decodeEntry = Schema.decodeUnknownResult(Entry)

/** One server as the file gives it, with its transport worked out. */
export interface Server {
  readonly kind: "stdio" | "http" | "sse"
  readonly entry: Entry
  /** The entry as written, which a check compares to tell a changed server. */
  readonly raw: unknown
}

/** The file's servers in the order it lists them. */
export type File = ReadonlyMap<string, Server>

export const empty: File = new Map()

/** What a read of the file gives: no file, a file that parses, or why it does not. */
export type Read =
  | { readonly _tag: "File"; readonly file: File }
  | { readonly _tag: "Malformed"; readonly error: string }

/** Parses the text of `mcp.json`. Every fault of the file's shape makes the whole file malformed, as in clanka. */
export const parse = (text: string): Read => {
  const malformed = (error: string): Read => ({ _tag: "Malformed", error })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return malformed(Messages.mcpNotJson(String((error as Error).message)))
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    return malformed(Messages.mcpNotObject)
  const listed = (json as Record<string, unknown>)["mcpServers"]
  if (listed === undefined) return { _tag: "File", file: empty }
  if (typeof listed !== "object" || listed === null || Array.isArray(listed))
    return malformed(Messages.mcpServersNotObject)
  const file = new Map<string, Server>()
  for (const [name, raw] of Object.entries(listed)) {
    const decoded = decodeEntry(raw)
    if (decoded._tag === "Failure")
      return malformed(Messages.mcpEntry(name, decoded.failure.message))
    const entry = decoded.success
    const kind =
      entry.type ??
      (entry.command !== undefined
        ? "stdio"
        : entry.url !== undefined
          ? "http"
          : undefined)
    if (kind === undefined)
      return malformed(Messages.mcpEntry(name, "needs a command or a url"))
    if (kind === "stdio" && entry.command === undefined)
      return malformed(
        Messages.mcpEntry(name, "a stdio server needs a command"),
      )
    if (kind === "http" && entry.url === undefined)
      return malformed(Messages.mcpEntry(name, "an http server needs a url"))
    file.set(name, { kind, entry, raw })
  }
  return { _tag: "File", file }
}

/** Reads `mcp.json` from a tree. A tree without one has no servers. */
export const read = Effect.fnUntraced(function* (tree: string | undefined) {
  if (tree === undefined)
    return { _tag: "File", file: empty } satisfies Read as Read
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(join(tree, fileName)).pipe(
    Effect.map((text): Read | string => text),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed<Read>({ _tag: "File", file: empty }),
    ),
    Effect.catch((error) =>
      Effect.succeed<Read>({
        _tag: "Malformed",
        error: Messages.mcpFileUnreadable(Errno.code(error)),
      }),
    ),
  )
  return typeof text === "string" ? parse(text) : text
})

/** Every `${NAME}` the file refers to, before expansion, which a secret change compares. */
export const names = (file: File | undefined): ReadonlySet<string> => {
  const found = new Set<string>()
  for (const server of file?.values() ?? []) {
    const { command, args, env, cwd, url, headers } = server.entry
    for (const name of Settings.names([command, args, env, cwd, url, headers]))
      found.add(name)
  }
  return found
}

/**
 * One server after expansion: the entry clanka takes, the name that resolved nowhere or the relative `cwd`, and each
 * name that expanded with the value it gave, which `scrubber` keeps out of what chad prints, logs and tells the model.
 */
export interface Resolved {
  readonly config: McpServers.ServerEntry
  readonly missing?: string
  /** The relative `cwd`, scrubbed. */
  readonly relative?: string
  readonly values: ReadonlyMap<string, string>
}

/**
 * Puts `${NAME}` back in place of each value the names expanded to, as it is and as JSON escapes it. An error from
 * clanka, a spawn's included, can quote a command, an argument, a `cwd`, a URL or a server's stderr, so every
 * diagnostic of a layer passes through it before it reaches the CLI, the log or the model.
 */
export const scrubber = (
  servers: Iterable<{ readonly values: ReadonlyMap<string, string> }>,
) => {
  const pairs = new Map<string, string>()
  for (const { values } of servers)
    for (const [name, value] of values) if (value !== "") pairs.set(value, name)
  // The longest value first, so one that holds another is replaced whole.
  const ordered = [...pairs].sort(([a], [b]) => b.length - a.length)
  return (text: string): string =>
    ordered.reduce(
      (out, [value, name]) =>
        out
          .replaceAll(value, `\${${name}}`)
          .replaceAll(JSON.stringify(value).slice(1, -1), `\${${name}}`),
      text,
    )
}

/**
 * Expands one server's names, the secret store first and then the daemon's environment, and builds the entry clanka
 * takes. Values of `env` and `headers` are `Redacted`, and a stdio server gets an absolute `cwd`, `home` when it
 * names none. A name that resolves nowhere, a lookup that fails and a relative
 * `cwd` each leave that one server unavailable.
 */
export const resolveServer = <E, R>(
  server: Server,
  lookup: Settings.Lookup<E, R>,
  home: string,
): Effect.Effect<Resolved, never, R> =>
  Effect.suspend(() => {
    const values = new Map<string, string>()
    const recorded: Settings.Lookup<E, R> = (name) =>
      Effect.tap(lookup(name), (found) =>
        Effect.sync(() => {
          if (Option.isSome(found)) values.set(name, found.value.value)
        }),
      )
    return resolveWith(server, recorded, home, values)
  })

const resolveWith = <E, R>(
  server: Server,
  lookup: Settings.Lookup<E, R>,
  home: string,
  values: ReadonlyMap<string, string>,
): Effect.Effect<Resolved, never, R> =>
  Effect.gen(function* () {
    const { entry } = server
    if (server.kind === "sse")
      return {
        config: {
          type: "unavailable",
          error: Messages.mcpSse,
        },
        values,
      } satisfies Resolved as Resolved
    const text = (value: string) =>
      Effect.map(Settings.expandString(value, lookup), ({ text }) => text)
    const record = (value: Readonly<Record<string, string>> | undefined) =>
      value === undefined
        ? Effect.succeed(undefined)
        : Effect.map(
            Effect.forEach(Object.entries(value), ([key, item]) =>
              Effect.map(
                text(item),
                (out) => [key, Redacted.make(out)] as const,
              ),
            ),
            (pairs) => Object.fromEntries(pairs),
          )
    const timeouts = {
      ...(entry.connectTimeout === undefined
        ? {}
        : { connectTimeout: Duration.millis(entry.connectTimeout) }),
      ...(entry.callTimeout === undefined
        ? {}
        : { callTimeout: Duration.millis(entry.callTimeout) }),
    }
    if (server.kind === "http") {
      const headers = yield* record(entry.headers)
      return {
        config: {
          type: "http",
          url: yield* text(entry.url!),
          ...(headers === undefined ? {} : { headers }),
          ...timeouts,
        },
        values,
      } satisfies Resolved as Resolved
    }
    const cwd = entry.cwd === undefined ? home : yield* text(entry.cwd)
    if (!isAbsolute(cwd)) {
      const relative = scrubber([{ values }])(cwd)
      return {
        config: {
          type: "unavailable",
          error: Messages.mcpRelativeCwd(relative),
        },
        relative,
        values,
      } satisfies Resolved as Resolved
    }
    const env = yield* record(entry.env)
    return {
      config: {
        type: "stdio",
        command: yield* text(entry.command!),
        ...(entry.args === undefined
          ? {}
          : { args: yield* Effect.forEach(entry.args, text) }),
        ...(env === undefined ? {} : { env }),
        cwd,
        ...timeouts,
      },
      values,
    } satisfies Resolved as Resolved
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<Resolved>(
        error instanceof Settings.MissingVariable
          ? {
              config: {
                type: "unavailable",
                error: Messages.mcpUnresolved(error.variable),
              },
              missing: error.variable,
              values,
            }
          : {
              config: {
                type: "unavailable",
                error: Messages.firstLine(
                  error instanceof Error ? error.message : String(error),
                ),
              },
              values,
            },
      ),
    ),
  )

/** Every server of a file after expansion, in the file's order. */
export const resolve = <E, R>(
  file: File,
  lookup: Settings.Lookup<E, R>,
  home: string,
) =>
  Effect.map(
    Effect.forEach([...file], ([name, server]) =>
      Effect.map(
        resolveServer(server, lookup, home),
        (resolved) => [name, resolved] as const,
      ),
    ),
    (pairs) => new Map(pairs) as ReadonlyMap<string, Resolved>,
  )

/** The servers an apply would add, remove or change, by the entries as written. */
export const diff = (before: File, after: File) => ({
  added: [...after.keys()].filter((name) => !before.has(name)),
  removed: [...before.keys()].filter((name) => !after.has(name)),
  changed: [...after.keys()].filter(
    (name) =>
      before.has(name) &&
      !Settings.same(before.get(name)!.raw, after.get(name)!.raw),
  ),
})
