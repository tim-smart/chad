import { dirname, join } from "node:path"
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
import * as Archive from "../Archive.ts"
import * as Daemon from "../Daemon.ts"
import * as Database from "../Database.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Flags from "../Flags.ts"
import * as Owner from "../Owner.ts"

/**
 * Takes the daemon lock for as long as the scope lasts, for a command that runs with no daemon (CLI-133, CLI-135).
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
 * call, which frees the place, and a CLI that dies frees it the same way (STO-93).
 */
const holdQueue = Effect.fnUntraced(function* (
  command: string,
  client: Daemon.Client,
) {
  const pull = yield* Stream.toPull(client.Backup())
  while (true) {
    const events = yield* Daemon.call(
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
    for (const event of events) {
      if (event._tag === "Held") return
      yield* Console.error(event.text)
    }
  }
})

/** `chad backup`: one tar of the volume, to a path or to standard output (STO-85 to STO-95, CLI-132, CLI-133). */
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
        if (client === undefined) yield* holdLock(command)
        else yield* holdQueue(command, client)
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
        )
      }),
    )
    if (written !== undefined)
      yield* Console.log(Messages.backupWritten(written))
  }),
).pipe(Command.withDescription("Write a backup of the volume as one tar"))

/** Whether the volume holds anything an owner made: a file under `secrets/` or a row in `sessions` (STO-179, STO-180). */
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
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        `the database cannot be read (${error instanceof Error ? error.message : String(error)})`,
      ),
    ),
  )
})

/**
 * Moves what the tar held from `staging` onto the volume. `db/`, `repo/` and every other directory the tar holds
 * replace the volume's, and `state/` is replaced file by file, because the daemon lock's file is in it and is held
 * (STO-181).
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
 * before anything is moved. A restore that a kill cut leaves that directory, and the next `chad restore` starts over
 * without the check for an empty volume, which the cut one passed (STO-99 to STO-103, STO-179 to STO-182, STO-216).
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
        const resumed = yield* fs.exists(staging)
        if (!resumed) {
          const what = yield* used(data)
          if (what !== undefined)
            return yield* failed(Messages.restoreNotEmpty(data, what))
        }
        const source = tar === "-" ? (yield* Stdio.Stdio).stdin : fs.stream(tar)
        const { manifest, whole } = yield* Archive.open(source).pipe(
          Effect.catchTag("NotBackup", (error) =>
            Effect.fail(failed(Messages.restoreNotBackup(tar, error.why))),
          ),
          Effect.catchTag("Newer", (error) =>
            Effect.fail(
              failed(Messages.restoreNewer(error.made, Archive.ownVersion)),
            ),
          ),
        )
        yield* fs.remove(staging, { recursive: true, force: true })
        yield* fs.makeDirectory(staging, { recursive: true })
        yield* Archive.extract(whole, staging)
        yield* install(data, staging)
        yield* fs.remove(staging, { recursive: true })
        yield* Console.log(Messages.restored(data, manifest.version))
      }),
    ).pipe(
      Effect.catchTag(["ArchiveError", "PlatformError"], (error) =>
        Effect.fail(failed(Messages.restoreFailed(error.message))),
      ),
    )
  }),
).pipe(Command.withDescription("Restore a backup onto an empty volume"))
