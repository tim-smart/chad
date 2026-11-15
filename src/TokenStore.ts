import { join } from "node:path"
import { Effect, FileSystem, Layer, Path } from "effect"
import { KeyValueStore } from "effect/persistence"
import type { PlatformError } from "effect/PlatformError"
import * as Paths from "./Paths.ts"

/**
 * The token store of the model logins: Effect's file system `KeyValueStore` in `secrets/auth/`, one file per key
 * (docs/spec/05-model-and-login.md, "Token store"). The daemon and the CLI both open it, so a login with no daemon
 * writes the same files. clanka's Codex login keeps its token under `codex.auth/`.
 *
 * The store writes a file with the process umask, which leaves a token readable by others under 022. Each write is
 * followed by a chmod to 0600 and the directory gets 0700, and the umask is never changed, because it is also the
 * mode of every file the agent creates (MOD-67, MOD-68, MOD-111).
 */
export const layer = (
  data: string,
): Layer.Layer<
  KeyValueStore.KeyValueStore,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(KeyValueStore.KeyValueStore)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = Paths.auth(data)
      const restrict = Effect.andThen(
        fs.makeDirectory(directory, { recursive: true }),
        fs.chmod(directory, 0o700),
      )
      yield* restrict
      const store = yield* KeyValueStore.KeyValueStore.pipe(
        Effect.provide(KeyValueStore.layerFileSystem(directory)),
      )
      /** The store's own error for a chmod that failed, so a caller sees one kind of failure. */
      const failed = (method: string, key: string | undefined) =>
        Effect.mapError(
          (cause: PlatformError) =>
            new KeyValueStore.KeyValueStoreError({
              method,
              ...(key === undefined ? {} : { key }),
              message: `Unable to make the token store private`,
              cause,
            }),
        )
      // Only the primitives are passed on, so `modify` and the rest go through the `set` below.
      return KeyValueStore.make({
        get: store.get,
        getUint8Array: store.getUint8Array,
        set: (key, value) =>
          Effect.andThen(
            store.set(key, value),
            fs
              .chmod(join(directory, encodeURIComponent(key)), 0o600)
              .pipe(failed("set", key)),
          ),
        remove: store.remove,
        clear: Effect.andThen(
          store.clear,
          restrict.pipe(failed("clear", undefined)),
        ),
        clearPrefix: store.clearPrefix,
        size: store.size,
        keys: store.keys,
      })
    }),
  )
