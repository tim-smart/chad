/**
 * The secret store, `secrets/secrets.json` on the volume: one JSON
 * object keyed by name, each entry a value, an optional note and the time it was saved. This module holds its shape and
 * its read. A missing file is an empty store.
 */
import { dirname, join } from "node:path"
import { Data, Effect, FileSystem, Option, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Errno from "./Errno.ts"

/** The store's file on the volume. */
export const file = (data: string): string => join(data, "secrets/secrets.json")

/** The pattern a stored name matches, and its most characters. */
export const NAME = /^[A-Z_][A-Z0-9_]*$/
export const NAME_MAX = 64

/** The name kept for writing a literal `${` in configuration, which `chad secret set` refuses. */
export const RESERVED = "CHAD_DOLLAR"

/** Whether `chad secret set` takes a name: the pattern, the length and not the reserved one. */
export const valid = (name: string): boolean =>
  NAME.test(name) && name.length <= NAME_MAX && name !== RESERVED

/** A name the store can hold. */
export const Name = Schema.String.check(
  Schema.isPattern(NAME),
  Schema.isMaxLength(NAME_MAX),
)

/** One stored secret. */
export const Entry = Schema.Struct({
  value: Schema.String,
  note: Schema.optionalKey(Schema.String),
  /** ISO time of the save. */
  date: Schema.String,
})
export type Entry = typeof Entry.Type

/** The content of `secrets/secrets.json`, keyed by name. */
export const Store = Schema.Record(Name, Entry)
export type Store = typeof Store.Type

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Store))

/** The store could not be read or does not hold a store. */
export class SecretsError extends Data.TaggedError("SecretsError")<{
  readonly message: string
}> {}

/** The store as the file holds it. A missing file is an empty store. */
export const read = (
  data: string,
): Effect.Effect<Store, SecretsError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file(data)).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Errno.code(error) === "ENOENT"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new SecretsError({
                message: `secrets/secrets.json cannot be read (${Errno.code(error)})`,
              }),
            ),
      ),
    )
    if (Option.isNone(text)) return {}
    // The parse error is left out: it can quote what the file holds, which may be a value.
    return yield* decode(text.value).pipe(
      Effect.mapError(
        () =>
          new SecretsError({
            message: "secrets/secrets.json is not a secret store",
          }),
      ),
    )
  })

/** Where a `${NAME}` found its value: the secret store or the daemon's process env. */
export type From = "store" | "env"

/**
 * Looks a name up in the secret store first and then in an environment, which is the daemon's process env as it
 * started. An empty value counts as none, as `Config.String` reads an empty variable. A value from the store is only
 * returned, and is never put into the environment.
 */
export const lookup =
  (data: string, env: Readonly<Record<string, string | undefined>>) =>
  (
    name: string,
  ): Effect.Effect<
    Option.Option<{ readonly value: string; readonly from: From }>,
    SecretsError,
    FileSystem.FileSystem
  > =>
    Effect.map(read(data), (store) => {
      const stored = Object.hasOwn(store, name) ? store[name]?.value : undefined
      if (stored !== undefined && stored !== "")
        return Option.some({ value: stored, from: "store" as const })
      const variable = env[name]
      return variable !== undefined && variable !== ""
        ? Option.some({ value: variable, from: "env" as const })
        : Option.none()
    })

/**
 * Writes the whole store by a temporary file and a rename, so a kill leaves the old store or the new one and never
 * part of either. `secrets/` gets mode 0700 and the file 0600 before it takes the store's name, each by a chmod, and
 * the process umask is left alone. The caller holds the daemon's queue or the lock.
 */
export const write = Effect.fnUntraced(function* (
  data: string,
  store: Store,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const target = file(data)
  const directory = dirname(target)
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.chmod(directory, 0o700)
  const temporary = `${target}.${process.pid}.tmp`
  yield* fs.writeFileString(temporary, JSON.stringify(store, null, 2) + "\n", {
    mode: 0o600,
  })
  yield* fs.chmod(temporary, 0o600)
  yield* fs.rename(temporary, target)
})

/** What a save or a removal did to the store, and the store after it. */
export type Changed =
  | {
      readonly _tag: "Saved"
      readonly replaced: boolean
      readonly store: Store
    }
  | { readonly _tag: "Removed"; readonly store: Store }
  | { readonly _tag: "Missing" }

/**
 * The store after a save. An existing name gets the new value and keeps its note unless one is given, and `""`
 * clears it.
 */
export const save = (
  store: Store,
  name: string,
  value: string,
  note: string | undefined,
  date: Date,
): Changed => {
  const previous = Object.hasOwn(store, name) ? store[name] : undefined
  const kept = note ?? previous?.note
  const entry: Entry = {
    value,
    ...(kept === undefined || kept === "" ? {} : { note: kept }),
    date: date.toISOString(),
  }
  return {
    _tag: "Saved",
    replaced: previous !== undefined,
    store: { ...store, [name]: entry },
  }
}

/** The store without a name, or `Missing` when it has none such. */
export const remove = (store: Store, name: string): Changed => {
  if (!Object.hasOwn(store, name)) return { _tag: "Missing" }
  const { [name]: _, ...rest } = store
  return { _tag: "Removed", store: rest }
}

/**
 * Reads the store, applies a change and writes it when something changed. A store that cannot be read or holds no
 * store fails, and nothing is written over it.
 */
export const change = (data: string, f: (store: Store) => Changed) =>
  Effect.gen(function* () {
    const changed = f(yield* read(data))
    if (changed._tag !== "Missing") yield* write(data, changed.store)
    return changed
  })
