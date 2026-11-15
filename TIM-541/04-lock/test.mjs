import { DatabaseSync } from "node:sqlite"
// non-destructive test a CLI could run: is the lock held?
const db = new DatabaseSync(process.argv[2], { timeout: 0 })
const s = process.hrtime.bigint()
try { db.exec("BEGIN IMMEDIATE; ROLLBACK;"); console.log("free") } catch (e) { console.log("held (" + e.message + ")") }
console.log("test took", Number(process.hrtime.bigint() - s) / 1e6, "ms")
