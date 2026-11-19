import { basename, dirname, join } from "node:path"
import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Pull,
  Stdio,
  Stream,
} from "effect"
import { Argument, Command, Flag } from "effect/cli"
import * as Lock from "../../Lock.ts"
import * as Messages from "../../Messages.ts"
import * as Paths from "../../Paths.ts"
import { Timings } from "../../Timings.ts"
import * as Archive from "../Archive.ts"
import * as Daemon from "../Daemon.ts"
import * as Database from "../Database.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Flags from "../Flags.ts"
import * as Owner from "../Owner.ts"

/**
 * Takes the daemon lock for as long as the scope lasts, for a command that runs with no daemon.
 * A daemon that took the lock since the lock test fails the command before it reads or writes anything.
 */
const holdLock = Effect.fnUntraced(function* (command: string) {
  const environment = yield* Environment
  const fs = yield* FileSystem.FileSystem
  yield* Effect.orDie(
    fs.makeDirectory(dirname(environment.lock), { recursive: true }),
  )
  yield* Effect.acquireRelease(
    Effect.suspend(() => {
      const release = Lock.take(environment.lock, Duration.zero)
      return release === undefined
        ? Effect.fail(
            new Failure({
              code: ExitCode.failed,
              message: Messages.daemonStarted(command),
            }),
          )
        : Effect.succeed(release)
    }),
    (release) => Effect.sync(release),
  )
})

/**
 * Takes a place in the running daemon's queue and holds it for as long as the scope lasts. Closing the scope ends the
 * call, which frees the place, and a CLI that dies frees it the same way. It gives an effect that fails once
 * the place is lost, because the daemon went away, so the tar is never finished without it.
 */
const holdQueue = Effect.fnUntraced(function* (
  command: string,
  client: Daemon.Client,
) {
  const pull = yield* Stream.toPull(client.Backup())
  const next = Daemon.call(
    command,
    pull.pipe(
      Pull.catchDone(() =>
        Effect.fail(
          new Failure({
            code: ExitCode.daemon,
            message: Messages.daemonGone(command),
          }),
        ),
      ),
    ),
  )
  while (true) {
    for (const event of yield* next) {
      // The effect that fails once the place is lost is the result, for the caller to race the tar against.
      // @effect-diagnostics-next-line returnEffectInGen:off
      if (event._tag === "Held") return Effect.forever(next)
      yield* Console.error(event.text)
    }
  }
})

/** `chad backup`: one tar of the volume, to a path or to standard output. */
export const backup = Command.make(
  "backup",
  {
    path: Argument.String("path").pipe(
      Argument.withDescription(
        "Where to write the tar, or - for standard output",
      ),
    ),
    noHome: Flags.boolean("no-home").pipe(
      Flag.withDescription("Leave home/ out of the tar"),
    ),
    sessions: Flags.boolean("sessions").pipe(
      Flag.withDescription("Put sessions/ in the tar"),
    ),
  },
  Effect.fn("backup")(function* ({ path, noHome, sessions }) {
    const command = "backup"
    const environment = yield* Environment
    const stdout = path === "-"
    if (stdout) {
      yield* Owner.only(command)
      if (yield* (yield* Stdio.Stdio).stdoutIsTerminal) {
        return yield* new Failure({
          code: ExitCode.usage,
          message: Messages.backupTerminal(),
        })
      }
    }
    const daemon = (yield* Daemon.lock) === "held"
    const client = daemon ? yield* Daemon.reach(command) : undefined
    if (client === undefined) yield* Files.writable(command)
    const written = yield* Effect.scoped(
      Effect.gen(function* () {
        const lost =
          client === undefined
            ? Effect.never
            : yield* holdQueue(command, client)
        if (client === undefined) yield* holdLock(command)
        return yield* Archive.create({
          data: environment.data,
          to: stdout ? undefined : path,
          home: !noHome,
          sessions,
        }).pipe(
          Effect.tapError((error) =>
            client === undefined
              ? Effect.void
              : Effect.ignore(client.BackupFailed({ error: error.message })),
          ),
          Effect.mapError(
            (error) =>
              new Failure({
                code: ExitCode.failed,
                message: Messages.backupFailed(error.message),
              }),
          ),
          // A lost place ends the tar, which removes a partial file and leaves a pipe's reader a cut tar.
          Effect.raceFirst(lost),
        )
      }),
    )
    if (written !== undefined)
      yield* Console.log(Messages.backupWritten(written))
  }),
).pipe(Command.withDescription("Write a backup of the volume as one tar"))

/** Whether the volume holds anything an owner made: a file under `secrets/` or a row in `sessions`. */
const used = Effect.fnUntraced(function* (data: string) {
  const fs = yield* FileSystem.FileSystem
  const secrets = join(data, "secrets")
  if (yield* fs.exists(secrets)) {
    for (const entry of yield* fs.readDirectory(secrets, { recursive: true })) {
      const info = yield* fs.stat(join(secrets, entry))
      if (info.type !== "Directory") return `secrets/${entry} exists`
    }
  }
  const database = Paths.database(data)
  if (!(yield* fs.exists(database))) return undefined
  return yield* Effect.try({
    try: () =>
      Database.query(database, "SELECT 1 FROM sessions LIMIT 1", 1).rows
        .length > 0
        ? "the database holds sessions"
        : undefined,
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.catch((reason) =>
      Effect.succeed(`the database cannot be read (${reason})`),
    ),
  )
})

/** The directories a backup holds beside its manifest, which are all that a restore moves onto the volume. */
const parts: ReadonlySet<string> = new Set([
  "db",
  "repo",
  "secrets",
  "state",
  "home",
  "sessions",
])

/** The parts whose files chad itself opens and writes, which hold no link, so nothing follows one off the volume. */
const plain = ["db", "secrets", "state"]

/**
 * Why the unpacked tar is not a backup to move onto the volume, or `undefined`. Each part is a directory and no link,
 * and nothing else is there, so the install never reaches outside `staging`. The lock's file is never in a backup,
 * and one that a tar brings is refused, because the restore holds the volume's.
 */
const unfit = Effect.fnUntraced(function* (staging: string) {
  const fs = yield* FileSystem.FileSystem
  for (const entry of yield* fs.readDirectory(staging)) {
    const info = yield* fs.lstat(join(staging, entry))
    if (entry === Archive.manifestName) {
      if (info.type !== "File") return `${entry} is not a file`
    } else if (!parts.has(entry)) {
      return `it holds ${entry}, which no backup holds`
    } else if (info.type !== "Directory") {
      return `${entry} is not a directory`
    }
  }
  for (const part of plain) {
    const root = join(staging, part)
    if (!(yield* fs.exists(root))) continue
    for (const entry of yield* fs.readDirectory(root, { recursive: true })) {
      const info = yield* fs.lstat(join(root, entry))
      if (info.type !== "File" && info.type !== "Directory") {
        return `${part}/${entry} is neither a file nor a directory`
      }
    }
  }
  if (yield* fs.exists(join(staging, "state", basename(Paths.lock(""))))) {
    return "it holds the daemon lock's file"
  }
  return undefined
})

/**
 * Moves what the tar held from `staging` onto the volume. `db/`, `repo/` and every other directory the tar holds
 * replace the volume's, and `state/` is replaced file by file, because the daemon lock's file is in it and is held.
 */
const install = Effect.fnUntraced(function* (data: string, staging: string) {
  const fs = yield* FileSystem.FileSystem
  for (const name of ["db", "repo"]) {
    yield* fs.remove(join(data, name), { recursive: true, force: true })
  }
  const state = join(data, "state")
  yield* fs.makeDirectory(state, { recursive: true })
  for (const entry of yield* fs.readDirectory(state)) {
    if (join(state, entry) === Paths.lock(data)) continue
    yield* fs.remove(join(state, entry), { recursive: true, force: true })
  }
  const stagedState = join(staging, "state")
  if (yield* fs.exists(stagedState)) {
    for (const entry of yield* fs.readDirectory(stagedState)) {
      yield* fs.rename(join(stagedState, entry), join(state, entry))
    }
    yield* fs.remove(stagedState, { recursive: true })
  }
  yield* fs.remove(join(staging, Archive.manifestName), { force: true })
  for (const entry of yield* fs.readDirectory(staging)) {
    yield* fs.remove(join(data, entry), { recursive: true, force: true })
    yield* fs.rename(join(staging, entry), join(data, entry))
  }
})

/**
 * `chad restore`: a tar of `chad backup` onto an empty volume, with no daemon and the lock held for the whole copy.
 * Everything it refuses for is checked before it writes, and the tar is unpacked under `restore.partial` on the volume
 * and checked before anything is moved. An unpacking that fails or is cut leaves the volume as it was, so the next
 * restore checks it again. Only once the unpacked tar is checked does `restore.installing` mark the volume as the
 * restore's: no daemon boots and no command writes while it exists, and the next `chad restore` replaces the volume
 * without the check for an empty one, which this one passed.
 */
export const restore = Command.make(
  "restore",
  {
    tar: Argument.String("tar").pipe(
      Argument.withDescription("The tar to restore, or - for standard input"),
    ),
  },
  Effect.fn("restore")(function* ({ tar }) {
    const command = "restore"
    yield* Owner.only(command)
    const environment = yield* Environment
    const fs = yield* FileSystem.FileSystem
    const data = environment.data
    if ((yield* Daemon.lock) === "held") {
      return yield* new Failure({
        code: ExitCode.failed,
        message: Messages.restoreDaemon(data),
      })
    }
    const failed = (message: string) =>
      new Failure({ code: ExitCode.failed, message })
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* holdLock(command)
        const staging = Paths.restoring(data)
        const cut = Paths.restoreCut(data)
        const resumed = yield* fs.exists(cut)
        if (!resumed) {
          const what = yield* used(data)
          if (what !== undefined)
            return yield* failed(Messages.restoreNotEmpty(data, what))
        }
        const source = tar === "-" ? (yield* Stdio.Stdio).stdin : fs.stream(tar)
        const { manifest, whole } = yield* Archive.open(source).pipe(
          Effect.catchTags({
            NotBackup: (error) =>
              Effect.fail(failed(Messages.restoreNotBackup(tar, error.why))),
            Newer: (error) =>
              Effect.fail(
                failed(Messages.restoreNewer(error.made, Archive.ownVersion)),
              ),
          }),
        )
        // From its first write on, the restore holds the restore lock too. A command that writes repo/work, with a daemon
        // running or not, takes it around its check of restore.installing and its write. The volume check above
        // needs no lock: it reads no file a scaffold writes, and a resumed restore's marker is there before either starts.
        const timings = yield* Timings
        yield* fs.makeDirectory(dirname(Paths.restoreLock(data)), {
          recursive: true,
          mode: 0o700,
        })
        yield* Effect.acquireRelease(
          Effect.suspend(() => {
            const release = Lock.take(Paths.restoreLock(data), timings.lockBusy)
            return release === undefined
              ? Effect.fail(failed(Messages.restoreBusy(command, data)))
              : Effect.succeed(release)
          }),
          (release) => Effect.sync(release),
        )
        yield* fs.remove(staging, { recursive: true, force: true })
        yield* fs.makeDirectory(staging, { recursive: true })
        const discard = Effect.ignore(
          fs.remove(staging, { recursive: true, force: true }),
        )
        yield* Archive.extract(whole, staging).pipe(
          Effect.onError(() => discard),
        )
        const why = yield* unfit(staging).pipe(Effect.onError(() => discard))
        if (why !== undefined) {
          yield* discard
          return yield* failed(Messages.restoreNotBackup(tar, why))
        }
        if (!resumed) yield* fs.writeFileString(cut, "")
        yield* install(data, staging)
        yield* fs.remove(staging, { recursive: true })
        yield* fs.remove(cut)
        yield* Console.log(Messages.restored(data, manifest.version))
      }),
    ).pipe(
      Effect.catchTag(["ArchiveError", "PlatformError"], (error) =>
        Effect.fail(failed(Messages.restoreFailed(error.message))),
      ),
    )
  }),
).pipe(Command.withDescription("Restore a backup onto an empty volume"))
