// unix socket server at argv[2]
import net from "node:net"
import fs from "node:fs"
const p = process.argv[2]
fs.mkdirSync(new URL("file://" + p + "/..").pathname, { recursive: true })
if (process.argv[3] === "unlink") { try { fs.unlinkSync(p) } catch {} }
const srv = net.createServer((c) => { c.end("hello from server pid " + process.pid + " uid " + process.getuid() + "\n") })
srv.on("error", (e) => { console.log("LISTEN ERROR:", e.code, e.message); process.exit(1) })
srv.listen(p, () => { console.log("listening on", p, "mode", (fs.statSync(p).mode & 0o777).toString(8), "uid", fs.statSync(p).uid) })
