// Does node:net expose the peer pid/uid of a unix socket connection (SO_PEERCRED)?
import net from "node:net"
import fs from "node:fs"
const p = "probe.sock"
try { fs.unlinkSync(p) } catch {}
const server = net.createServer((conn) => {
  const names = new Set()
  for (let o = conn; o; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add(n)
  for (let o = conn._handle; o; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add("_handle." + n)
  const hits = [...names].filter((n) => /cred|peer|pid|uid/i.test(n))
  console.log("socket/handle members matching cred|peer|pid|uid:", JSON.stringify(hits))
  console.log("remoteAddress:", conn.remoteAddress, "handle fd:", conn._handle.fd)
  conn.destroy(); server.close(); fs.rmSync(p, { force: true })
})
server.listen(p, () => net.connect(p).on("error", () => {}))
