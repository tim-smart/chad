import net from "node:net"
const c = net.connect(process.argv[2])
c.on("data", (d) => process.stdout.write("CONNECTED: " + d))
c.on("error", (e) => { console.log("CONNECT ERROR:", e.code, e.message); process.exit(1) })
