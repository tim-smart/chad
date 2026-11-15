// PROTOTYPE (TIM-554). A stdio MCP server whose one tool says which key it was started with, by hash.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createHash } from "node:crypto"

const key = process.env.KEY ?? ""
const server = new McpServer({ name: "echo", version: "0.0.0" })
server.tool("whoami", "Which key this server was started with, by hash.", {}, async () => ({
  content: [{ type: "text", text: "pid=" + process.pid + " keyLength=" + key.length + " keySha=" + createHash("sha256").update(key).digest("hex").slice(0, 16) }]
}))
await server.connect(new StdioServerTransport())
