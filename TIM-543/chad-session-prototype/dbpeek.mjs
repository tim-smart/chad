
import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(process.argv[2], { readOnly: true })
for (const t of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all()) {
  const n = db.prepare("SELECT count(*) c FROM " + t.name).get().c
  console.log(t.name, n, t.sql.replace(/\s+/g, " ").slice(0, 420))
}
if (process.argv[3]) console.log(JSON.stringify(db.prepare(process.argv[3]).all(), null, 1).slice(0, 3000))
