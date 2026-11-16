// Backup, restore and the version of the volume, in layer 4: the built CLI and `chad serve` as child processes on a
// volume of the test's own (docs/spec/02-storage.md, "Backup and restore" and "Migrations and the order of a boot").
import { execFileSync, spawn } from "node:child_process"
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
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { expect, it, onTestFinished } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { version } from "../../dist/Version.js"
import { chad, owner, start } from "../support/cli.ts"
import { execute, query } from "../support/database.ts"
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

const entries = (tar: string) =>
  execFileSync("tar", ["--list", "--file", tar], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")

it("STO-85 STO-86 STO-88 STO-89 STO-90 STO-178 STO-94 STO-99 STO-179 STO-181 STO-182 STO-101 CLI-134 CLI-135 IMG-41 a backup of a running daemon's volume restores onto an empty volume that boots with its secrets, its drafts and its applied repo, and restore refuses a used volume, a running daemon and a newer tar without writing", async () => {
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

it("STO-93 CLI-133 a backup with a daemon running holds its place in the queue until the tar is written, so a change that comes meanwhile waits for it and runs after it", async () => {
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

it("STO-48 IMG-127 FAIL-146 STO-193 an older chad serve on a volume a newer chad wrote exits 1 and writes nothing on it but its log, and gives the steps back only when the copy taken before the migration is its own", async () => {
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

it("STO-44 STO-45 STO-156 STO-157 STO-158 STO-192 STO-190 the first boot of a new image copies the database before it migrates, with the version it came from beside it, and a boot that finds state/migrating takes no second copy over it", async () => {
  const data = directory("chad-migrate-")
  const first = await serve(data)
  first.child.kill("SIGKILL")
  await first.done
  // The volume as an older chad left it: an older version, and the newest migration not run yet.
  const older = () => {
    writeFileSync(join(data, "state/version"), "0.0.0-old\n")
    execute(
      data,
      "DELETE FROM effect_sql_migrations WHERE migration_id = 5; DROP TABLE timers",
    )
  }
  older()

  const second = await serve(data)
  const copy = join(data, "db/chad.db.before-migration")
  expect(readFileSync(`${copy}.version`, "utf8")).toBe("0.0.0-old\n")
  expect(readFileSync(join(data, "state/version"), "utf8")).toBe(`${version}\n`)
  expect(existsSync(join(data, "state/migrating"))).toBe(false)
  expect(existsSync(`${copy}.partial`)).toBe(false)
  const opened = new DatabaseSync(copy, { readOnly: true })
  expect(
    opened
      .prepare("SELECT name FROM sqlite_master WHERE name = 'timers'")
      .all(),
  ).toEqual([])
  opened.close()
  expect(second.output()).toContain("event=database.migrated")
  second.child.kill("SIGKILL")
  await second.done

  // A migration that a crash cut leaves state/migrating, and the boot that retries it keeps the copy it has.
  older()
  writeFileSync(join(data, "state/migrating"), `${version}\n`)
  writeFileSync(`${copy}.version`, "0.0.0-first\n")
  const kept = statSync(copy).mtimeMs
  const third = await serve(data)
  expect(statSync(copy).mtimeMs).toBe(kept)
  expect(readFileSync(`${copy}.version`, "utf8")).toBe("0.0.0-first\n")
  expect(existsSync(join(data, "state/migrating"))).toBe(false)
  third.child.kill("SIGKILL")
  await third.done
}, 60_000)
