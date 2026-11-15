// PROTOTYPE for "The MCP layer rebuild run with calls in flight" (TIM-555). Throwaway.
//
// An MCP server the scenarios can slow down, hang and restart.
//   node mcp-server.mjs <name>              stdio, started by clanka from mcp.json
//   node mcp-server.mjs <name> --http PORT  streamable HTTP, started by the scenario
//
// Its behaviour is read from $MCP_CTL/<name>.json when it starts:
//   label         a word that shows which start of the server answered
//   tools         which of echo, slow, stubborn, store it lists
//   storeType     "string" or "number": the type of store's parameter
//   connectMs     how long it waits before it answers initialize (a slow npx download)
//   ignoreTerm    do not exit on a closed stdin or SIGTERM
// Every start, call and exit goes to the scenario's event log.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

const [name, mode, port] = process.argv.slice(2)
const LOG = process.env.PROTO_LOG ?? "events.jsonl"
const log = (ev, data = {}) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ev: "server." + ev, server: name, ...data }) + "\n")
const ctlFile = join(process.env.MCP_CTL ?? ".", name + ".json")
const ctl = { label: "v1", tools: ["echo", "slow", "stubborn", "store"], storeType: "string", connectMs: 0, ignoreTerm: false, ...(existsSync(ctlFile) ? JSON.parse(readFileSync(ctlFile, "utf8")) : {}) }
// A secret reaches the server through its environment, the way mcp.json passes one.
const token = process.env.TOKEN ?? "none"
const stamp = () => ctl.label + " " + name + " pid " + process.pid + " token " + token

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")) })
})

const declarations = {
  echo: { name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  slow: { name: "slow", description: "Wait, then answer. Stops when the call is cancelled.", inputSchema: { type: "object", properties: { ms: { type: "number" }, tag: { type: "string" } }, required: ["ms", "tag"], additionalProperties: false } },
  stubborn: { name: "stubborn", description: "Wait, then answer. Ignores a cancellation.", inputSchema: { type: "object", properties: { ms: { type: "number" }, tag: { type: "string" } }, required: ["ms", "tag"], additionalProperties: false } },
  store: { name: "store", description: "Store a value.", inputSchema: { type: "object", properties: { n: { type: ctl.storeType } }, required: ["n"], additionalProperties: false } }
}

const makeServer = () => {
  const server = new Server({ name, version: "0.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ctl.tools.map((t) => declarations[t]) }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name: tool, arguments: args } = request.params
    const text = (value) => ({ content: [{ type: "text", text: value }] })
    switch (tool) {
      case "echo":
        log("echo", { text: args.text })
        return text(stamp() + ": " + args.text)
      case "slow":
        log("slow.start", { tag: args.tag })
        extra.signal.addEventListener("abort", () => log("slow.cancelled", { tag: args.tag }))
        await sleep(args.ms, extra.signal)
        log("slow.end", { tag: args.tag })
        return text(stamp() + ": slow " + args.tag)
      case "stubborn":
        log("stubborn.start", { tag: args.tag })
        extra.signal.addEventListener("abort", () => log("stubborn.sawCancel", { tag: args.tag }))
        await sleep(args.ms)
        // The side effect that happens whatever the caller was told.
        log("stubborn.end", { tag: args.tag })
        return text(stamp() + ": stubborn " + args.tag)
      case "store":
        log("store", { n: args.n, type: typeof args.n })
        return text(stamp() + ": stored " + JSON.stringify(args.n) + " (" + typeof args.n + ")")
    }
    return { isError: true, content: [{ type: "text", text: "no such tool " + tool }] }
  })
  return server
}

process.on("exit", (code) => log("exit", { code }))
if (ctl.ignoreTerm) {
  process.on("SIGTERM", () => log("ignoredSigterm"))
  setInterval(() => {}, 1000)
} else {
  process.on("SIGTERM", () => { log("sigterm"); process.exit(0) })
}

log("start", { label: ctl.label, mode: mode ?? "stdio", connectMs: ctl.connectMs, tools: ctl.tools })
if (mode === "--http") {
  const sessions = new Map()
  createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
    const id = req.headers["mcp-session-id"]
    let transport = id === undefined ? undefined : sessions.get(id)
    if (transport === undefined && req.method === "POST") {
      if (ctl.connectMs > 0) await sleep(ctl.connectMs)
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => void sessions.set(sid, transport) })
      await makeServer().connect(transport)
    }
    if (transport === undefined) {
      res.writeHead(404).end()
      return
    }
    log("http", { method: req.method, rpc: Array.isArray(body) ? body.map((b) => b.method) : body?.method ?? null })
    if (req.method === "DELETE") log("sessionDeleted")
    await transport.handleRequest(req, res, body)
  }).listen(Number(port), "127.0.0.1", () => log("listening", { port: Number(port) }))
} else {
  if (ctl.connectMs > 0) await sleep(ctl.connectMs)
  const transport = new StdioServerTransport()
  if (!ctl.ignoreTerm) process.stdin.on("end", () => { log("stdinEnded"); process.exit(0) })
  else process.stdin.on("end", () => log("ignoredStdinEnd"))
  await makeServer().connect(transport)
  log("connected")
}
