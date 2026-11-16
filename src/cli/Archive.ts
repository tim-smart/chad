import { join, resolve } from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import {
  Data,
  Effect,
  FileSystem,
  Pull,
  Result,
  Schema,
  SemVer,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Messages from "../Messages.ts"
import * as Paths from "../Paths.ts"
import { version } from "../Version.ts"

/**
 * The tar of `chad backup` and `chad restore` (docs/spec/02-storage.md, "Backup and restore"). GNU tar writes and reads
 * it, and the CLI puts the manifest and the copy of the database in front of what it takes from the volume.
 */

/** The first entry of the tar (STO-89, STO-178). */
export const manifestName = "manifest.json"

/** This chad's version, which a restore names when it refuses a newer tar. */
export const ownVersion = version

/** The format number of the tar. A restore refuses a higher one (STO-89, STO-215). */
export const format = 1

/** What `manifest.json` holds: the format number and the chad version that made the tar (STO-215). */
export const Manifest = Schema.Struct({
  format: Schema.Number,
  version: Schema.String,
})
export type Manifest = typeof Manifest.Type

const decodeManifest = Schema.decodeUnknownResult(
  Schema.fromJsonString(Manifest),
)

export class ArchiveError extends Data.TaggedError("ArchiveError")<{
  readonly message: string
}> {}

/** The tar is no backup of chad's. */
export class NotBackup extends Data.TaggedError("NotBackup")<{
  readonly why: string
}> {}

/** The tar was made by a newer chad, or in a newer format (STO-182). */
export class Newer extends Data.TaggedError("Newer")<{
  readonly made: string
}> {}

/** What `chad backup` takes from the volume beside the database, in the order the tar holds them (STO-86 to STO-88). */
const taken = (options: {
  readonly home: boolean
  readonly sessions: boolean
}) => [
  "repo/work",
  "secrets",
  "state",
  ...(options.home ? ["home"] : []),
  ...(options.sessions ? ["sessions"] : []),
]

/**
 * What tar leaves out of the volume's paths: the lock's file, which a restore never replaces, and the tools' cache
 * under `home/` (STO-86, STO-98).
 */
const excluded = ["state/daemon.lock", "home/.cache"]

/** Runs GNU tar and fails with what it said when it exits with a code that `ok` does not hold. */
const tar = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  options: {
    readonly stdin?: Stream.Stream<Uint8Array, unknown>
    readonly stdout: "inherit" | "ignore"
    readonly ok: ReadonlyArray<number>
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [stderr, code] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("tar", args, {
          stdin:
            options.stdin === undefined
              ? "ignore"
              : (options.stdin as Stream.Stream<Uint8Array, never>),
          stdout: options.stdout,
          stderr: "pipe",
        }),
      )
      return yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
        { concurrency: 2 },
      )
    }),
  ).pipe(
    Effect.mapError((error) => new ArchiveError({ message: error.message })),
  )
  if (!options.ok.includes(Number(code))) {
    return yield* new ArchiveError({
      message: `tar exited with ${Number(code)}: ${Messages.firstLine(stderr.trim())}`,
    })
  }
})

/** Copies the database with SQLite's online backup, on a read-only connection of the CLI's own (STO-92). */
const copyDatabase = (from: string, to: string) =>
  Effect.tryPromise({
    try: async () => {
      const source = new DatabaseSync(from, { readOnly: true })
      try {
        await backup(source, to)
      } finally {
        source.close()
      }
    },
    catch: (error) =>
      new ArchiveError({
        message: `the database could not be copied: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })

/**
 * Writes the tar to `to`, or to standard output when it is undefined. The manifest and the online copy of the database
 * are made in a directory under `cache/`, which no backup holds, and a tar written to a path is renamed into place once
 * it is complete, and removed when it is not (STO-218). GNU tar's exit code 1 is a file that changed while it was read, as a running session's may.
 */
export const create = (options: {
  readonly data: string
  readonly to: string | undefined
  readonly home: boolean
  readonly sessions: boolean
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cache = join(options.data, "cache")
    yield* fs.makeDirectory(cache, { recursive: true })
    const staging = yield* fs.makeTempDirectoryScoped({
      directory: cache,
      prefix: "backup-",
    })
    yield* fs.writeFileString(
      join(staging, manifestName),
      `${JSON.stringify({ format, version } satisfies Manifest)}\n`,
    )
    const staged = [manifestName]
    const database = Paths.database(options.data)
    if (yield* fs.exists(database)) {
      yield* fs.makeDirectory(join(staging, "db"))
      yield* copyDatabase(database, join(staging, "db/chad.db"))
      staged.push("db/chad.db")
    }
    const present: Array<string> = []
    for (const path of taken(options)) {
      if (yield* fs.exists(join(options.data, path))) present.push(path)
    }
    const target = options.to === undefined ? undefined : resolve(options.to)
    const partial = target === undefined ? "-" : `${target}.partial`
    yield* tar(
      [
        "--create",
        "--file",
        partial,
        "--anchored",
        ...excluded.map((path) => `--exclude=${path}`),
        "--directory",
        staging,
        ...staged,
        "--directory",
        options.data,
        ...present,
      ],
      { stdout: target === undefined ? "inherit" : "ignore", ok: [0, 1] },
    ).pipe(
      Effect.onError(() =>
        target === undefined
          ? Effect.void
          : Effect.ignore(fs.remove(partial, { force: true })),
      ),
    )
    if (target !== undefined) yield* fs.rename(partial, target)
    return target
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ArchiveError({ message: error.message })),
    ),
  )

const text = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("utf8").replace(/\0.*$/s, "").trim()

/**
 * Reads the manifest off the front of the tar and gives it with the whole tar as a stream, so a tar that arrives on a
 * pipe is checked before anything else is read and before anything is written (STO-178, STO-182).
 */
export const open = <E>(source: Stream.Stream<Uint8Array, E>) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(source)
    const chunks: Array<Uint8Array> = []
    let length = 0
    let ended = false
    const fill = Effect.fnUntraced(function* (wanted: number) {
      while (length < wanted && !ended) {
        const next = yield* pull.pipe(
          Pull.catchDone(() => Effect.succeed(undefined)),
        )
        if (next === undefined) {
          ended = true
          break
        }
        for (const chunk of next) {
          chunks.push(chunk)
          length += chunk.length
        }
      }
      return Buffer.concat(chunks)
    })
    const header = yield* fill(512)
    if (header.length < 512 || text(header.subarray(0, 100)) !== manifestName) {
      return yield* new NotBackup({
        why: `its first entry is not ${manifestName}`,
      })
    }
    const size = Number.parseInt(text(header.subarray(124, 136)), 8)
    const head = yield* fill(512 + size)
    const decoded = decodeManifest(
      Buffer.from(head.subarray(512, 512 + size)).toString("utf8"),
    )
    if (!Number.isSafeInteger(size) || Result.isFailure(decoded)) {
      return yield* new NotBackup({ why: `${manifestName} cannot be read` })
    }
    const manifest = decoded.success
    const made = SemVer.parse(manifest.version)
    if (
      manifest.format > format ||
      Result.isFailure(made) ||
      SemVer.isGreaterThan(made.success, SemVer.parseUnsafe(version))
    ) {
      return yield* new Newer({ made: manifest.version })
    }
    const whole: Stream.Stream<Uint8Array, E> = Stream.concat(
      Stream.make(head),
      Stream.fromPull(Effect.succeed(pull)),
    )
    return { manifest, whole }
  })

/** Unpacks the tar into `directory`. */
export const extract = (
  whole: Stream.Stream<Uint8Array, unknown>,
  directory: string,
) =>
  tar(["--extract", "--file", "-", "--directory", directory], {
    stdin: whole,
    stdout: "ignore",
    ok: [0],
  })
