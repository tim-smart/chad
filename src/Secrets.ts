/**
 * The secret store, `secrets/secrets.json` on the volume (docs/spec/15-credentials.md, "The secret store"): one JSON
 * object keyed by name, each entry a value, an optional note and the time it was saved. This module holds its shape and
 * its read. A missing file is an empty store.
 */
import { join } from "node:path"
import { Data, Effect, FileSystem, Option, Schema } from "effect"
import * as Errno from "./Errno.ts"

/** The store's file on the volume (CRED-16). */
export const file = (data: string): string => join(data, "secrets/secrets.json")

/** The pattern a stored name matches, and its most characters (CRED-18). */
export const NAME = /^[A-Z_][A-Z0-9_]*$/
export const NAME_MAX = 64

/** A name the store can hold. */
export const Name = Schema.String.check(
  Schema.isPattern(NAME),
  Schema.isMaxLength(NAME_MAX),
)

/** One stored secret (CRED-17). */
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
                message: `secrets/secrets.json cannot be read: ${error.message}`,
              }),
            ),
      ),
    )
    if (Option.isNone(text)) return {}
    return yield* decode(text.value).pipe(
      Effect.mapError(
        (error) =>
          new SecretsError({
            message: `secrets/secrets.json is not a secret store: ${error.message}`,
          }),
      ),
    )
  })

/** Where a `${NAME}` found its value: the secret store or the daemon's process env (SET-20). */
export type From = "store" | "env"

/**
 * Looks a name up in the secret store first and then in an environment, which is the daemon's process env as it
 * started. An empty value counts as none, as `Config.String` reads an empty variable. A value from the store is only
 * returned, and is never put into the environment (SET-20, SET-21).
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
