// A stdio MCP server small enough to read: it answers initialize, tools/list and ping.
// On start it records its own environment and starts a child that records its own.
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as readline from "node:readline"

const out = process.env.PROBE_OUT ?? "/data/state"
fs.writeFileSync(out + "/mcp-server.env", "CHAD_SESSION=" + (process.env.CHAD_SESSION ?? "<unset>") + "\npgid-is-own=" + (process.pid === Number(fs.readFileSync("/proc/self/stat", "utf8").split(" ")[4])) + "\n")
spawn("sh", ["-c", "echo CHAD_SESSION=${CHAD_SESSION:-<unset>} > " + out + "/mcp-child.env"], { stdio: "ignore" })
process.on("exit", () => fs.writeFileSync(out + "/mcp-server.exit", String(Date.now())))
// PROBE_STUBBORN: a server that ignores its stdin closing and SIGTERM, the kind TIM-555 measured at 4 s to close.
if (process.argv[2] === "stubborn") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdin.on("end", () => {}) }
else process.on("SIGTERM", () => { fs.writeFileSync(out + "/mcp-server.term", String(Date.now())); process.exit(0) })

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } } })
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "noop", description: "Does nothing.", inputSchema: { type: "object", properties: {} } }] } })
  send({ jsonrpc: "2.0", id: m.id, result: {} })
})
