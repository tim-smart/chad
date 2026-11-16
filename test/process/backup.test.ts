// Backup, restore and the version of the volume, in layer 4: the built CLI and `chad serve` as child processes on a
// volume of the test's own.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  watch,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { Duration } from "effect"
import { expect, it, onTestFinished } from "vitest"
import * as Lock from "../../dist/Lock.js"
import * as Messages from "../../dist/Messages.js"
import { version } from "../../dist/Version.js"
import { chad, owner, type Running, start } from "../support/cli.ts"
import { execute, query } from "../support/database.ts"
import { runs, start as fakeModel } from "../support/model.ts"
import { eventually, posted, rows, says } from "../support/owner.ts"
import { daemon } from "../support/process.ts"
import { path } from "../support/repo.ts"

const directory = (prefix: string) => {
  const made = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => rmSync(made, { recursive: true, force: true }))
  return made
}

/** Starts `chad serve` on the volume and waits until it is ready. A kill at the end of the test is its only stop. */
const serve = async (data: string) => {
  const daemon = start(["serve"], { CHAD_DATA: data })
  onTestFinished(() => void daemon.child.kill("SIGKILL"))
  await daemon.printed("event=boot.ready")
  return daemon
}

/** Every file under a directory with its size and modification time, which a refused boot must not change. */
const files = (root: string, under = ""): Record<string, string> => {
  const found: Record<string, string> = {}
  for (const entry of readdirSync(join(root, under), { withFileTypes: true })) {
    const name = join(under, entry.name)
    if (name === "logs") continue
    const info = lstatSync(join(root, name))
    found[name] = `${info.size}@${info.mtimeMs}`
    if (entry.isDirectory()) Object.assign(found, files(root, name))
  }
  return found
}

/**
 * Waits until a file appears in a directory, with no clock: the directory is watched, so a boot can be killed the
 * moment it takes a step. It fails if the command ends first.
 */
const appears = (directory: string, name: string, running: Running) =>
  new Promise<void>((resolve, reject) => {
    mkdirSync(directory, { recursive: true })
    const watcher = watch(directory, () => {
      if (!existsSync(join(directory, name))) return
      watcher.close()
      resolve()
    })
    if (existsSync(join(directory, name))) {
      watcher.close()
      resolve()
    }
    void running.done.then((ran) => {
      watcher.close()
      reject(new Error(`ended before ${name}: ${ran.stdout}${ran.stderr}`))
    })
  })

/** A tar of a directory's entries, in the order given, the way a hand-made or damaged backup is made. */
const tarOf = (from: string, names: ReadonlyArray<string>) => {
  const made = join(directory("chad-tar-"), "made.tar")
  execFileSync("tar", [
    "--create",
    "--file",
    made,
    "--directory",
    from,
    ...names,
  ])
  return made
}

const manifest = (into: string) =>
  writeFileSync(
    join(into, "manifest.json"),
    JSON.stringify({ format: 1, version }),
  )

/** The pid of the `tar` a process runs, read off `/proc`. */
const tarRunBy = (parent: number | undefined) => {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
      if (name === "tar" && ppid === parent) return Number(entry)
    } catch {
      // The process ended while it was read.
    }
  }
  return undefined
}

/** Whether a stopped process has ended, or has a SIGTERM or a SIGKILL waiting for it to go on. */
const toldToEnd = (pid: number) => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8")
    if (/^State:\s+Z/m.test(status)) return true
    let pending = 0n
    for (const [, mask] of status.matchAll(/^(?:SigPnd|ShdPnd):\s+(\w+)$/gm)) {
      pending |= BigInt(`0x${mask}`)
    }
    return (pending & ((1n << 14n) | (1n << 8n))) !== 0n
  } catch {
    return true
  }
}

const entries = (tar: string) =>
  execFileSync("tar", ["--list", "--file", tar], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")

it("a backup of a running daemon's volume restores onto an empty volume that boots with its secrets, its drafts and its applied repo, and restore refuses a used volume, a running daemon and a newer tar without writing", async () => {
  const data = directory("chad-backup-")
  mkdirSync(join(data, "secrets"))
  writeFileSync(join(data, "secrets/token"), "secret")
  mkdirSync(join(data, "home/.cache"), { recursive: true })
  writeFileSync(join(data, "home/notes"), "kept")
  writeFileSync(join(data, "home/.cache/tool"), "dropped")
  const first = await serve(data)
  writeFileSync(join(data, "repo/work/draft.md"), "never applied")
  mkdirSync(join(data, "sessions/one"), { recursive: true })
  mkdirSync(join(data, "cache"), { recursive: true })
  execute(
    data,
    "INSERT INTO sessions (id, thread, created_at) VALUES ('kept', 'local:dm', 1)",
  )

  const tar = join(directory("chad-tar-"), "chad.tar")
  expect(await chad(["backup", tar], { CHAD_DATA: data })).toMatchObject({
    code: 0,
  })
  const listed = entries(tar)
  expect(listed[0]).toBe("manifest.json")
  expect(listed).toContain("db/chad.db")
  expect(listed).toContain("repo/work/.git/")
  expect(listed).toContain("repo/work/draft.md")
  expect(listed).toContain("secrets/token")
  expect(listed).toContain("home/notes")
  expect(
    listed.filter(
      (entry) => entry.startsWith("repo/") && !entry.startsWith("repo/work"),
    ),
  ).toEqual([])
  for (const left of [
    "home/.cache",
    "sessions",
    "logs",
    "cache",
    "state/daemon.lock",
    "db/chad.db.before-migration",
  ]) {
    expect(
      listed.filter((entry) => entry.startsWith(left)),
      left,
    ).toEqual([])
  }

  // A used volume, and the same volume with its daemon running, are refused, and nothing on them changes.
  first.child.kill("SIGKILL")
  await first.done
  const before = files(data)
  expect(await chad(["restore", tar], { CHAD_DATA: data })).toMatchObject({
    code: 1,
  })
  expect(files(data)).toEqual(before)
  const again = await serve(data)
  expect(await chad(["restore", tar], { CHAD_DATA: data })).toEqual({
    stdout: "",
    stderr: `${Messages.restoreDaemon(data)}\n`,
    code: 1,
  })
  again.child.kill("SIGKILL")
  await again.done

  // A tar a newer chad made is refused before anything is written, from a pipe as from a file.
  const newer = directory("chad-newer-")
  writeFileSync(
    join(newer, "manifest.json"),
    JSON.stringify({ format: 1, version: "99.0.0" }),
  )
  mkdirSync(join(newer, "secrets"))
  writeFileSync(join(newer, "secrets/token"), "newer")
  const newerTar = join(directory("chad-tar-"), "newer.tar")
  execFileSync("tar", [
    "--create",
    "--file",
    newerTar,
    "--directory",
    newer,
    "manifest.json",
    "secrets",
  ])
  const empty = directory("chad-empty-")
  expect(
    await chad(
      ["restore", "-"],
      { CHAD_DATA: empty },
      readFileSync(newerTar, "utf8"),
    ),
  ).toMatchObject({ code: 1 })
  expect(existsSync(join(empty, "secrets"))).toBe(false)
  expect(existsSync(join(empty, "db"))).toBe(false)

  const restored = directory("chad-restored-")
  expect(await chad(["restore", tar], { CHAD_DATA: restored })).toMatchObject({
    code: 0,
  })
  expect(readFileSync(join(restored, "secrets/token"), "utf8")).toBe("secret")
  expect(readFileSync(join(restored, "repo/work/draft.md"), "utf8")).toBe(
    "never applied",
  )
  expect(readFileSync(join(restored, "home/notes"), "utf8")).toBe("kept")
  expect(existsSync(join(restored, "home/.cache"))).toBe(false)
  expect(existsSync(join(restored, "sessions/one"))).toBe(false)
  expect(query(restored, "SELECT id FROM sessions")).toEqual([{ id: "kept" }])
  const booted = await serve(restored)
  expect(existsSync(join(restored, "repo/live"))).toBe(true)
  expect(readdirSync(join(restored, "repo/versions")).length).toBeGreaterThan(0)
  booted.child.kill("SIGKILL")
  await booted.done
}, 60_000)

it("a backup with a daemon running holds its place in the queue until the tar is written, so a change that comes meanwhile waits for it and runs after it", async () => {
  const data = directory("chad-queue-")
  const daemon = await serve(data)
  // More than a pipe holds, so a reader that does not read stops the tar part way.
  mkdirSync(join(data, "home"), { recursive: true })
  writeFileSync(join(data, "home/large"), randomBytes(8 * 1024 * 1024))

  const backup = spawn(process.execPath, [path("bin/chad.js"), "backup", "-"], {
    env: owner({ CHAD_DATA: data }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  onTestFinished(() => void backup.kill("SIGKILL"))
  const ended = new Promise<number | null>((resolve) =>
    backup.on("close", resolve),
  )
  // The tar starts only once the place is held.
  await new Promise((resolve) => backup.stdout.once("readable", resolve))

  const change = start(["timezone", "Europe/London"], { CHAD_DATA: data })
  // The daemon says the change waits only when the queue is held, and the backup holds it until it ends.
  await change.printed(Messages.queueWaiting("chad backup"))
  let finished = false
  void change.done.then(() => (finished = true))

  let bytes = 0
  backup.stdout.on("data", (chunk: Buffer) => (bytes += chunk.length))
  expect(await ended).toBe(0)
  expect(finished).toBe(false)
  expect(bytes).toBeGreaterThan(8 * 1024 * 1024)
  expect((await change.done).code).toBe(0)
  daemon.child.kill("SIGKILL")
  await daemon.done
}, 60_000)

it("an older chad serve on a volume a newer chad wrote exits 1 and writes nothing on it but its log, and gives the steps back only when the copy taken before the migration is its own", async () => {
  const data = directory("chad-newer-")
  const first = await serve(data)
  first.child.kill("SIGKILL")
  await first.done
  writeFileSync(join(data, "state/version"), "99.0.0\n")
  writeFileSync(join(data, "db/chad.db.before-migration"), "copy")

  for (const [beside, copy] of [
    [`${version}\n`, version],
    ["0.0.1-old\n", "0.0.1-old"],
  ] as const) {
    writeFileSync(join(data, "db/chad.db.before-migration.version"), beside)
    const before = files(data)
    const refused = await chad(["serve"], { CHAD_DATA: data })
    expect(refused.code).toBe(1)
    expect(refused.stdout + refused.stderr).toContain(
      Messages.volumeNewer({
        data,
        volume: "99.0.0",
        own: version,
        copy: {
          path: join(data, "db/chad.db.before-migration"),
          version: copy,
        },
      }).split("\n")[0],
    )
    expect(files(data)).toEqual(before)
  }
}, 60_000)

it("the first boot of a new image copies the database before it migrates: a kill during the copy leaves no copy and the next boot takes it again, and a kill during the migration keeps the copy and its version, which the boot that retries takes no second copy over", async () => {
  const data = directory("chad-migrate-")
  const first = await serve(data)
  first.child.kill("SIGKILL")
  await first.done
  // The volume as an older chad left it: an older version, and the newest migration not run yet. 64 MiB of rows make
  // the copy long enough to kill part way.
  writeFileSync(join(data, "state/version"), "0.0.0-old\n")
  execute(
    data,
    `DELETE FROM effect_sql_migrations WHERE migration_id = 5; DROP TABLE timers;
     CREATE TABLE ballast (b BLOB);
     WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1024)
     INSERT INTO ballast SELECT randomblob(65536) FROM n;
     INSERT INTO sessions (id, thread, created_at) VALUES ('kept', 'local:dm', 1)`,
  )
  const copy = join(data, "db/chad.db.before-migration")
  const tables = (database: string) => {
    const opened = new DatabaseSync(database, { readOnly: true })
    try {
      return opened
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('timers', 'ballast')",
        )
        .all()
        .map((row) => row["name"])
    } finally {
      opened.close()
    }
  }

  // Killed while the copy is written.
  const copying = start(["serve"], { CHAD_DATA: data })
  onTestFinished(() => void copying.child.kill("SIGKILL"))
  await appears(join(data, "db"), "chad.db.before-migration.partial", copying)
  copying.child.kill("SIGKILL")
  await copying.done
  expect(existsSync(copy)).toBe(false)
  expect(existsSync(`${copy}.version`)).toBe(false)
  expect(existsSync(join(data, "state/migrating"))).toBe(false)

  // Killed while the migration runs: a write transaction of the test's own holds it after the copy.
  const holding = new DatabaseSync(join(data, "db/chad.db"))
  holding.exec("BEGIN IMMEDIATE")
  const migrating = start(["serve"], { CHAD_DATA: data })
  onTestFinished(() => void migrating.child.kill("SIGKILL"))
  await appears(join(data, "state"), "migrating", migrating)
  migrating.child.kill("SIGKILL")
  await migrating.done
  holding.exec("ROLLBACK")
  holding.close()
  expect(existsSync(`${copy}.partial`)).toBe(false)
  expect(readFileSync(`${copy}.version`, "utf8")).toBe("0.0.0-old\n")
  expect(tables(copy)).toEqual(["ballast"])
  expect(readFileSync(join(data, "state/version"), "utf8")).toBe("0.0.0-old\n")
  const kept = statSync(copy)

  const third = await serve(data)
  expect(statSync(copy).ino).toBe(kept.ino)
  expect(statSync(copy).mtimeMs).toBe(kept.mtimeMs)
  expect(readFileSync(`${copy}.version`, "utf8")).toBe("0.0.0-old\n")
  expect(tables(copy)).toEqual(["ballast"])
  expect(readFileSync(join(data, "state/version"), "utf8")).toBe(`${version}\n`)
  expect(existsSync(join(data, "state/migrating"))).toBe(false)
  expect(third.output()).toContain("event=database.migrated")
  expect(query(data, "SELECT id FROM sessions")).toEqual([{ id: "kept" }])
  third.child.kill("SIGKILL")
  await third.done
  expect(tables(join(data, "db/chad.db")).sort()).toEqual(["ballast", "timers"])
}, 60_000)

/** A volume with a secret, backed up with no daemon, and the tar. */
const backedUp = async () => {
  const data = directory("chad-source-")
  const first = await serve(data)
  first.child.kill("SIGKILL")
  await first.done
  mkdirSync(join(data, "secrets"), { recursive: true })
  writeFileSync(join(data, "secrets/token"), "secret")
  mkdirSync(join(data, "home"), { recursive: true })
  writeFileSync(join(data, "home/large"), randomBytes(4 * 1024 * 1024))
  const tar = join(directory("chad-tar-"), "chad.tar")
  expect(await chad(["backup", tar], { CHAD_DATA: data })).toMatchObject({
    code: 0,
  })
  return tar
}

it("a restore - whose producer keeps standard input open ends with the restore, exit 0, and a SIGINT part way ends it with exit 130 without waiting for the input to close", async () => {
  const whole = readFileSync(await backedUp())
  /** `chad restore -` with standard input left open after `input`, and its exit code when it ends. */
  const restore = (data: string, input: Buffer) => {
    const child = spawn(
      process.execPath,
      [path("bin/chad.js"), "restore", "-"],
      {
        env: owner({ CHAD_DATA: data }),
        stdio: ["pipe", "ignore", "ignore"],
      },
    )
    onTestFinished(() => void child.kill("SIGKILL"))
    const code = new Promise<number | null>((resolve) =>
      child.on("close", (exit) => resolve(exit)),
    )
    // A restore that ends before it read all of the input closes the pipe under the rest.
    child.stdin.on("error", () => {})
    child.stdin.write(input)
    return { child, code }
  }

  // A pipe that stays open after the whole tar, as a one-off container whose standard input nobody closes leaves it.
  const complete = directory("chad-target-")
  expect(await restore(complete, whole).code).toBe(0)
  expect(readFileSync(join(complete, "secrets/token"), "utf8")).toBe("secret")

  const cut = directory("chad-target-")
  const interrupted = restore(cut, whole.subarray(0, whole.length / 2))
  await eventually(
    () => existsSync(join(cut, "restore.partial")),
    (there) => there,
  )
  interrupted.child.kill("SIGINT")
  expect(await interrupted.code).toBe(130)
})

it("a restore holds the lock against chad serve, and one that a kill or a damaged tar cut while unpacking leaves the volume to the next restore's check, so a secret written since is never replaced", async () => {
  const tar = await backedUp()
  const whole = readFileSync(tar)
  const data = directory("chad-target-")

  // A tar that ends part way fails, and leaves nothing to resume.
  const cut = join(directory("chad-tar-"), "cut.tar")
  writeFileSync(cut, whole.subarray(0, whole.length / 2))
  expect(await chad(["restore", cut], { CHAD_DATA: data })).toMatchObject({
    code: 1,
  })
  expect(existsSync(join(data, "restore.partial"))).toBe(false)
  expect(existsSync(join(data, "secrets"))).toBe(false)

  // Cut by a kill part way through the tar, which arrives on a pipe that stalls.
  const restoring = spawn(
    process.execPath,
    [path("bin/chad.js"), "restore", "-"],
    {
      env: owner({ CHAD_DATA: data }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  onTestFinished(() => void restoring.kill("SIGKILL"))
  const ended = new Promise<NodeJS.Signals | null>((resolve) =>
    restoring.on("close", (_, signal) => resolve(signal)),
  )
  restoring.stdin.write(whole.subarray(0, whole.length / 2))
  await eventually(
    () => existsSync(join(data, "restore.partial")),
    (there) => there,
  )
  const refused = await chad(["serve"], { CHAD_DATA: data })
  expect(refused.code).toBe(1)
  expect(refused.stdout + refused.stderr).toContain("event=boot.refused")
  restoring.kill("SIGKILL")
  expect(await ended).toBe("SIGKILL")
  expect(existsSync(join(data, "restore.partial"))).toBe(true)
  expect(existsSync(join(data, "restore.installing"))).toBe(false)

  // The volume was used since, so the next restore is refused.
  mkdirSync(join(data, "secrets"))
  writeFileSync(join(data, "secrets/later"), "since")
  expect(await chad(["restore", tar], { CHAD_DATA: data })).toMatchObject({
    code: 1,
  })
  expect(readdirSync(join(data, "secrets"))).toEqual(["later"])
  expect(readFileSync(join(data, "secrets/later"), "utf8")).toBe("since")
}, 60_000)

it("a restore cut while it replaces the volume leaves it to the restore alone: chad serve, a command that writes, one that was already waiting on its model's trial and the starter files of chad plugin new and chad skill new are refused, and the restore run again finishes it into a volume that boots", async () => {
  const tar = await backedUp()
  const data = directory("chad-target-")
  // A chad model with no daemon that passed its check of the volume before the restore, and waits on its trial.
  const model = await fakeModel()
  onTestFinished(() => model.close())
  const trial = model.holdChecks("fenced")
  const inFlight = start(["model", "openai-compat/fenced"], {
    CHAD_DATA: data,
    CHAD_MODEL: "openai-compat/fake",
    CHAD_OPENAI_API_URL: model.url,
    CHAD_OPENAI_API_KEY: "fake-key",
  })
  onTestFinished(() => void inFlight.child.kill("SIGKILL"))
  await trial.reached
  // A directory the restore cannot remove cuts it after it has begun to replace what is on the volume.
  mkdirSync(join(data, "repo/work/stuck"), { recursive: true })
  writeFileSync(join(data, "repo/work/stuck/file"), "stuck")
  execFileSync("chmod", ["0555", join(data, "repo/work/stuck")])
  onTestFinished(() => void execFileSync("chmod", ["-R", "u+w", data]))
  expect(await chad(["restore", tar], { CHAD_DATA: data })).toMatchObject({
    code: 1,
  })
  expect(existsSync(join(data, "restore.installing"))).toBe(true)

  const refused = await chad(["serve"], { CHAD_DATA: data })
  expect(refused.code).toBe(1)
  expect(refused.stdout + refused.stderr).toContain("reason=restore")
  expect(
    await chad(["timezone", "Europe/London"], { CHAD_DATA: data }),
  ).toEqual({
    stdout: "",
    stderr: `${Messages.restoreUnfinished("timezone", data)}\n`,
    code: 1,
  })
  // The cut left repo/work, so the scaffold commands reach their write, and the restore lock's check refuses it.
  expect(existsSync(join(data, "repo/work"))).toBe(true)
  for (const command of [
    ["plugin", "new", "after-cut"],
    ["skill", "new", "after-cut"],
  ]) {
    expect(await chad(command, { CHAD_DATA: data })).toEqual({
      stdout: "",
      stderr: `${Messages.restoreUnfinished(command.slice(0, 2).join(" "), data)}\n`,
      code: 1,
    })
  }
  // While another holds the restore lock, a scaffold command and the restore each wait for it and are refused, so no
  // restore begins between a scaffold's check and its write, with a daemon running or not.
  let holder = Lock.take(join(data, "run/restore.lock"), Duration.zero)
  onTestFinished(() => holder?.())
  expect(
    await chad(["plugin", "new", "while-held"], { CHAD_DATA: data }),
  ).toEqual({
    stdout: "",
    stderr: `${Messages.restoreBusy("plugin new", data)}\n`,
    code: 1,
  })
  expect(await chad(["restore", tar], { CHAD_DATA: data })).toMatchObject({
    code: 1,
    stderr: `${Messages.restoreBusy("restore", data)}\n`,
  })
  holder?.()
  holder = undefined
  expect(existsSync(join(data, "repo/work/plugins/after-cut.ts"))).toBe(false)
  expect(existsSync(join(data, "repo/work/plugins/while-held.ts"))).toBe(false)
  expect(existsSync(join(data, "repo/work/skills/after-cut"))).toBe(false)
  expect(existsSync(join(data, "restore.installing"))).toBe(true)
  trial.release()
  expect(await inFlight.done).toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining(Messages.restoreUnfinished("model", data)),
  })
  expect(existsSync(join(data, "state/model"))).toBe(false)

  execFileSync("chmod", ["0755", join(data, "repo/work/stuck")])
  expect(await chad(["restore", tar], { CHAD_DATA: data })).toMatchObject({
    code: 0,
  })
  expect(existsSync(join(data, "restore.installing"))).toBe(false)
  expect(existsSync(join(data, "restore.partial"))).toBe(false)
  expect(existsSync(join(data, "repo/work/stuck"))).toBe(false)
  expect(readFileSync(join(data, "secrets/token"), "utf8")).toBe("secret")
  const booted = await serve(data)
  booted.child.kill("SIGKILL")
  await booted.done
}, 60_000)

it("a restore refuses a tar whose state is a link off the volume or that brings its own daemon lock, without touching what is outside or the lock it holds, and backup to standard output and restore are refused to a session and to a terminal", async () => {
  const data = directory("chad-target-")
  const outside = directory("chad-outside-")
  writeFileSync(join(outside, "sentinel"), "outside")

  const linked = directory("chad-linked-")
  manifest(linked)
  symlinkSync(outside, join(linked, "state"))
  expect(
    await chad(["restore", tarOf(linked, ["manifest.json", "state"])], {
      CHAD_DATA: data,
    }),
  ).toMatchObject({ code: 1 })
  expect(readdirSync(outside)).toEqual(["sentinel"])
  expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside")
  expect(existsSync(join(data, "state/sentinel"))).toBe(false)

  const lock = join(data, "state/daemon.lock")
  const held = statSync(lock).ino
  const locked = directory("chad-locked-")
  manifest(locked)
  mkdirSync(join(locked, "state"))
  writeFileSync(join(locked, "state/daemon.lock"), "")
  mkdirSync(join(locked, "secrets"))
  writeFileSync(join(locked, "secrets/token"), "theirs")
  expect(
    await chad(
      ["restore", tarOf(locked, ["manifest.json", "state", "secrets"])],
      { CHAD_DATA: data },
    ),
  ).toMatchObject({ code: 1 })
  expect(statSync(lock).ino).toBe(held)
  expect(existsSync(join(data, "secrets"))).toBe(false)
  expect(existsSync(join(data, "restore.partial"))).toBe(false)
  expect(existsSync(join(data, "restore.installing"))).toBe(false)

  const session = { CHAD_DATA: data, CHAD_SESSION: "a-session" }
  expect(await chad(["backup", "-"], session)).toMatchObject({
    code: 3,
    stdout: "",
  })
  expect(await chad(["restore", "-"], session)).toMatchObject({ code: 3 })
  const terminal = spawnSync(
    "script",
    [
      "-qec",
      `'${process.execPath}' '${path("bin/chad.js")}' backup -`,
      "/dev/null",
    ],
    { env: owner({ CHAD_DATA: data }), encoding: "utf8" },
  )
  expect(terminal.status).toBe(2)
  expect(terminal.stdout).toContain(Messages.backupTerminal())
}, 60_000)

it("a backup whose daemon goes away while it holds the queue ends with exit 4 and never finishes the tar, and one to a file that SIGINT ends removes its partial file, leaves the backup already at that path as it was and frees the queue at once", async () => {
  const data = directory("chad-lost-")
  const daemon = await serve(data)
  mkdirSync(join(data, "home"), { recursive: true })
  writeFileSync(join(data, "home/large"), randomBytes(8 * 1024 * 1024))

  /** `chad backup -` to a pipe nobody reads yet, once the tar has begun. */
  const stalled = async () => {
    const backup = spawn(
      process.execPath,
      [path("bin/chad.js"), "backup", "-"],
      {
        env: owner({ CHAD_DATA: data }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    onTestFinished(() => void backup.kill("SIGKILL"))
    let stderr = ""
    backup.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)))
    const ended = new Promise<number | null>((resolve) =>
      backup.on("close", resolve),
    )
    await new Promise((resolve) => backup.stdout.once("readable", resolve))
    return { backup, ended, stderr: () => stderr }
  }

  const lost = await stalled()
  daemon.child.kill("SIGKILL")
  await daemon.done
  // The backup ends while its reader still reads nothing, so the tar never got past what the pipe holds.
  expect(await lost.ended).toBe(4)
  expect(lost.stderr()).toContain(Messages.daemonGone("backup"))
  let bytes = 0
  for await (const chunk of lost.backup.stdout)
    bytes += (chunk as Buffer).length
  expect(bytes).toBeLessThan(8 * 1024 * 1024)

  // A file takes what tar writes as fast as it writes, so tar itself is stopped once the partial file exists, and goes
  // on only once the CLI has told it to end. A sparse gigabyte keeps tar writing long enough to be stopped.
  const again = await serve(data)
  writeFileSync(join(data, "home/sparse"), "")
  truncateSync(join(data, "home/sparse"), 1024 ** 3)
  const target = join(directory("chad-tar-"), "chad.tar")
  writeFileSync(target, "the previous backup")
  const interrupted = spawn(
    process.execPath,
    [path("bin/chad.js"), "backup", target],
    { env: owner({ CHAD_DATA: data }), stdio: ["ignore", "pipe", "pipe"] },
  )
  onTestFinished(() => void interrupted.kill("SIGKILL"))
  const interruptedEnded = new Promise<number | null>((resolve) =>
    interrupted.on("close", resolve),
  )
  await eventually(
    () => existsSync(`${target}.partial`),
    (there) => there,
  )
  const writing = await eventually(
    () => tarRunBy(interrupted.pid),
    (pid) => pid !== undefined,
  )
  process.kill(writing!, "SIGSTOP")
  onTestFinished(() => void spawnSync("kill", ["-CONT", String(writing)]))
  interrupted.kill("SIGINT")
  await eventually(
    () => toldToEnd(writing!),
    (told) => told,
  )
  spawnSync("kill", ["-CONT", String(writing)])
  expect(await interruptedEnded).toBe(130)
  expect(existsSync(`${target}.partial`)).toBe(false)
  expect(readFileSync(target, "utf8")).toBe("the previous backup")
  const change = await chad(["timezone", "Europe/London"], { CHAD_DATA: data })
  expect(change.code).toBe(0)
  expect(change.stdout + change.stderr).not.toContain(
    Messages.queueWaiting("chad backup"),
  )
  again.child.kill("SIGKILL")
  await again.done
}, 60_000)

it("a seeded volume backed up, restored onto an emptied volume and booted by a newer chad goes on as it was: the conversation resumes with its history and the cron job its plugin stored fires", async () => {
  const running = await daemon({ bundled: true })
  const { fakes, data } = running
  await fakes.model.script([
    runs(
      'console.log(await cronCreate({ name: "later", prompt: "Say that it is later.", in: "2 seconds" }))',
    ),
    { text: "Set." },
    { text: "It is later." },
    { text: "Welcome back." },
  ])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "remind me later")
  await fakes.chat.answers(thread, 1)
  const [job] = rows(running, "SELECT value FROM plugin_kv_cron")
  const at = Number(
    JSON.parse(Buffer.from(job!["value"] as Uint8Array).toString())["at"],
  )
  expect((await first.stop()).code).toBe(0)

  const tar = join(directory("chad-tar-"), "chad.tar")
  expect(await running.chad(["backup", tar])).toMatchObject({ code: 0 })
  // Everything goes but the socket of the test's chat platform, which is no part of a volume.
  for (const entry of readdirSync(data)) {
    if (entry !== "run") rmSync(join(data, entry), { recursive: true })
  }
  expect(await running.chad(["restore", tar])).toMatchObject({ code: 0 })
  // As an older chad left it, so the boot takes the copy before it migrates.
  writeFileSync(join(data, "state/version"), "0.0.0-old\n")
  // The job's time passes while chad is down.
  await eventually(
    () => Date.now(),
    (now) => now > at,
  )

  await running.start()
  await fakes.chat.answers(thread, 2)
  expect(
    readFileSync(join(data, "db/chad.db.before-migration.version"), "utf8"),
  ).toBe("0.0.0-old\n")
  expect(readFileSync(join(data, "state/version"), "utf8")).toBe(`${version}\n`)
  await says(running, thread, "are you still there?")
  await fakes.chat.answers(thread, 3)
  expect(await posted(running, thread)).toEqual([
    "Set.",
    "It is later.",
    "Welcome back.",
  ])
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(4)
  expect(JSON.stringify(calls.at(-1)?.body)).toContain("remind me later")
  expect(JSON.stringify(calls.at(-1)?.body)).toContain("It is later.")
}, 60_000)
