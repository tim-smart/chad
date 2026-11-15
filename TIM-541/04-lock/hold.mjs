import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(process.argv[2], { timeout: 0 })
try {
  db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;")
  console.log("HELD by", process.pid)
  if (process.argv[3] === "hold") setInterval(() => {}, 1000)
  else { db.exec("ROLLBACK"); db.close() }
} catch (e) { console.log("REFUSED:", e.code ?? "", e.message); process.exit(1) }
