// A stdio MCP server for the tests, spoken to as newline-delimited JSON-RPC, as the SDK's stdio transport does.
//   --tools a,b    the tools it lists
//   --mark DIR     a tool call named hang writes DIR/hang before it waits forever
//   --gate FILE    it answers initialize only once FILE is gone
//   --stubborn     it ignores its standard input closing and SIGTERM
//   --exit         it exits at once, as a server that cannot start
// A tool call named quit answers, then the server exits, as one that drops after it connected.
// The tools: echo and fill give their arguments back, as browse's fill does for a field that is not a password, and
// fill also writes them to stderr, as a server's diagnostic may, and fails on the ref gone with the value in its error,
// snapshot gives those of the last fill, as a page shows what a field holds, token the sha256 of TOKEN with CHAD_SESSION, cwd
// its working directory, hang never answers, and any other gives its own name.
import { createHash } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const flag = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const tools = (flag("--tools") ?? "echo")
  .split(",")
  .filter((name) => name !== "")
const mark = flag("--mark")
const gate = flag("--gate")
const stubborn = process.argv.includes("--stubborn")
if (process.argv.includes("--exit")) {
  process.stderr.write("the fixture server was told to exit\n")
  process.exit(1)
}

if (stubborn) {
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1000)
}

let filled = {}

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
const text = (value) => ({ content: [{ type: "text", text: value }] })

const answer = (request) => {
  const { id, method, params } = request
  if (method === "initialize") {
    const reply = () =>
      send({
        id,
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
      })
    if (gate === undefined) return reply()
    const wait = () => (existsSync(gate) ? setTimeout(wait, 20) : reply())
    return wait()
  }
  if (method === "tools/list")
    return send({
      id,
      result: {
        tools: tools.map((name) => ({
          name,
          description: `The ${name} tool`,
          inputSchema: {
            type: "object",
            properties: { x: { type: "number" } },
          },
        })),
      },
    })
  if (method === "tools/call") {
    const { name, arguments: args } = params
    if (name === "hang") {
      if (mark !== undefined)
        writeFileSync(join(mark, "hang"), String(process.pid))
      return
    }
    if (name === "fill") {
      process.stderr.write(`fill ${JSON.stringify(args ?? {})}\n`)
      if (args?.ref === "gone")
        return send({
          id,
          result: {
            ...text(`no element gone to fill with ${args.value}`),
            isError: true,
          },
        })
      filled = args ?? {}
    }
    if (name === "echo" || name === "fill")
      return send({ id, result: text(JSON.stringify(args ?? {})) })
    if (name === "snapshot")
      return send({ id, result: text(`textbox e7: ${filled.value ?? ""}`) })
    if (name === "token")
      return send({
        id,
        result: text(
          `${createHash("sha256")
            .update(process.env.TOKEN ?? "")
            .digest("hex")} ${process.env.CHAD_SESSION}`,
        ),
      })
    if (name === "cwd") return send({ id, result: text(process.cwd()) })
    if (name === "quit") {
      send({ id, result: text("bye") })
      return setTimeout(() => process.exit(0), 20)
    }
    return send({ id, result: text(name) })
  }
  if (id !== undefined) send({ id, result: {} })
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (
    let index = buffer.indexOf("\n");
    index !== -1;
    index = buffer.indexOf("\n")
  ) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== "") answer(JSON.parse(line))
  }
})
process.stdin.on("end", () => {
  if (!stubborn) process.exit(0)
})
