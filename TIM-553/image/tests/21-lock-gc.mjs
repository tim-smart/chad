// Run on a host with node 26:  node --expose-gc tests/21-lock-gc.mjs
// The lock from "The chad CLI's socket, lock and session marker run for real" (TIM-550) is a SQLite write
// transaction held open for the life of the daemon. This shows what happens to it when nothing refers to
// the handle any more, which is how the stand-in daemon held it until this run.
import { DatabaseSync } from "node:sqlite"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chad-lock-"))
const probe = (file) => execFileSync(process.execPath, ["-e", `
  const { DatabaseSync } = require("node:sqlite")
  const d = new DatabaseSync(process.argv[1], { timeout: 0 })
  try { d.exec("BEGIN IMMEDIATE"); console.log("free") } catch { console.log("held") }
`, file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
const take = (file) => {
  const lock = new DatabaseSync(file, { timeout: 0 })
  lock.exec("CREATE TABLE IF NOT EXISTS holder (pid INTEGER); BEGIN IMMEDIATE; INSERT INTO holder VALUES (1)")
  return lock
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dropped = path.join(dir, "dropped.lock"), kept = path.join(dir, "kept.lock")
take(dropped)                       // the handle is not kept
globalThis.keptLock = take(kept)    // the handle is kept
console.log("just taken:            dropped handle " + probe(dropped) + ", kept handle " + probe(kept))
globalThis.gc(); await sleep(50); globalThis.gc()
console.log("after a collection:    dropped handle " + probe(dropped) + ", kept handle " + probe(kept))
fs.rmSync(dir, { recursive: true, force: true })
