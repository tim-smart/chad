import { join } from "node:path"
import { Effect, FileSystem, Layer, Path } from "effect"
import { KeyValueStore } from "effect/persistence"
import type { PlatformError } from "effect/PlatformError"
import type { LoginKind } from "./ModelText.ts"
import * as Paths from "./Paths.ts"

/**
 * The token store of the model logins: Effect's file system `KeyValueStore` in `secrets/auth/`, one file per key.
 * The daemon and the CLI both open it, so a login with no daemon
 * writes the same files. clanka's Codex login keeps its token under `codex.auth/`, and its Antigravity sign-in under
 * `antigravity.auth/`.
 *
 * The store writes a file with the process umask, which leaves a token readable by others under 022. Each write is
 * followed by a chmod to 0600 and the directory gets 0700, and the umask is never changed, because it is also the
 * mode of every file the agent creates.
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

/** The file that holds a login's token, under clanka's key `codex.auth/token` or `antigravity.auth/token`. */
export const file = (data: string, login: LoginKind): string =>
  join(Paths.auth(data), encodeURIComponent(`${login}.auth/token`))

/** Whether a login's token is stored, which is what `chad status` calls logged in. It opens no store. */
export const stored = Effect.fnUntraced(
  function* (data: string, login: LoginKind) {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(file(data, login))
  },
  Effect.orElseSucceed(() => false),
)

/**
 * The store over another whose every write first runs `before`, as a login with no daemon takes the lock only when
 * it stores the token. `before` gives what releases the lock once the write is done.
 */
export const guarded = (
  store: KeyValueStore.KeyValueStore,
  before: Effect.Effect<() => void>,
): KeyValueStore.KeyValueStore =>
  KeyValueStore.make({
    get: store.get,
    getUint8Array: store.getUint8Array,
    set: (key, value) =>
      Effect.acquireUseRelease(
        before,
        () => store.set(key, value),
        (release) => Effect.sync(release),
      ),
    remove: store.remove,
    clear: store.clear,
    clearPrefix: store.clearPrefix,
    size: store.size,
    keys: store.keys,
  })
