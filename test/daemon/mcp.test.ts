// MCP servers as the owner, the model and the CLI reach them: `mcp.json` checked, applied and rebuilt, `${NAME}` from
// the secret store, the calls the model makes while the layer rebuilds, and a boot on a malformed or slow file
// (docs/spec/12-skills-and-mcp.md).
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { write } from "../support/applied.ts"
import * as Cli from "../support/cli.ts"
import { scenario, type Scenario } from "../support/driver.ts"
import { results, runs, type Call } from "../support/model.ts"
import { eventually, lines, says } from "../support/owner.ts"

const server = fileURLToPath(
  new URL("../fixtures/mcp/server.mjs", import.meta.url),
)

/** A stdio entry that runs the fixture server with its flags. */
const fixture = (...flags: ReadonlyArray<string>) => ({
  command: process.execPath,
  args: [server, ...flags],
})

const mcpJson = (servers: object) =>
  JSON.stringify({ mcpServers: servers }, null, 2) + "\n"

/** The system prompt a model call sends. */
const systemText = (call: Call | undefined) =>
  (
    (
      call?.body as {
        messages?: ReadonlyArray<{ role?: string; content?: unknown }>
      }
    )?.messages ?? []
  )
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
    .join("\n")

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** One owner turn that runs a script and ends, and the calls the model received for it. */
const turn = async (running: Scenario, script: string | undefined) => {
  const thread = await running.fakes.chat.makeThread("direct")
  const ended = running
    .log()
    .filter((line) => line.annotations["event"] === "turn.ended").length
  await running.fakes.model.script(
    script === undefined ? [{ text: "ok" }] : [runs(script), { text: "ok" }],
  )
  await says(running, thread, "go")
  await lines(running, "turn.ended", ended + 1)
  return running.fakes.model.calls()
}

const apply = (running: Scenario, message: string) =>
  running.chad(["apply", "-m", message])

test("MCP-20 MCP-21 MCP-22 MCP-23 MCP-24 MCP-25 MCP-26 MCP-27 MCP-30 MCP-31 MCP-32 MCP-33 MCP-34 MCP-35 MCP-36 MCP-40 MCP-43 MCP-109 MCP-110 MCP-111 MCP-112 MCP-113 MCP-114 CLI-67 CLI-70 CLI-74 CLI-102 CLI-125f CRED-25 CRED-27 REC-28 an applied mcp.json connects its servers with names from the secret store that never reach the environment or any output, a failed or unavailable server does not block the apply, a secret it names rebuilds it, and a malformed file or a relative cwd fails the check and the apply", async () => {
  const running = await scenario()
  const work = join(running.data, "repo/work")
  const canary = "canary-7f3e-not-in-env"
  expect(
    (await running.chad(["secret", "set", "TOKEN"], {}, canary + "\n")).code,
  ).toBe(0)

  write(work, {
    "mcp.json": mcpJson({
      tools: {
        ...fixture("--tools", "echo,token,cwd"),
        env: { TOKEN: "${TOKEN}" },
      },
      broken: fixture("--exit"),
      missing: { ...fixture(), args: [server, "${NOPE_NOT_SET}"] },
      legacy: { type: "sse", url: "http://127.0.0.1:1/sse" },
    }),
  })
  // A check connects nothing, names what an apply adds and warns of the name that resolves nowhere (MCP-36, MCP-113).
  const check = await running.chad(["check"])
  expect(check.code).toBe(0)
  expect(check.stdout).toContain("MCP server tools: an apply adds it.")
  expect(check.stdout).toContain(
    Messages.mcpCheckUnresolved("missing", "NOPE_NOT_SET"),
  )
  expect(check.stdout).toContain("The check connected no MCP server.")

  // The apply prints its commit line first, then each server once the layer is current (MCP-35, MCP-111, MCP-112).
  const applied = await apply(running, "Add MCP servers")
  expect(applied.code).toBe(0)
  const out = applied.stdout.split("\n")
  const at = (text: string) => out.findIndex((line) => line.startsWith(text))
  expect(at("MCP server tools: connected, 3 tools.")).toBeGreaterThan(0)
  expect(at("MCP server broken: unavailable:")).toBeGreaterThan(0)
  expect(applied.stdout).toContain(
    `MCP server missing: unavailable: ${Messages.mcpUnresolved("NOPE_NOT_SET")}`,
  )
  expect(applied.stdout).toContain(
    "MCP server legacy: unavailable: SSE transport is not supported",
  )

  // The model calls the server. The token reached it from the store, and it runs in HOME as the daemon (MCP-31, MCP-109).
  const calls = await turn(
    running,
    "console.log(await mcp.tools.echo({ x: 1 })); console.log(await mcp.tools.token({})); console.log(await mcp.tools.cwd({}))",
  )
  expect(systemText(calls[0])).toContain("- tools (3 tools)")
  expect(systemText(calls[0])).toContain("- broken: failed to connect")
  const printed = results(calls[1]).join("\n")
  expect(printed).toContain('{"x":1}')
  expect(printed).toContain(`${sha(canary)} daemon`)
  expect(printed).toContain(`\n${process.env["HOME"]}\n`)

  const status = await running.chad(["status"])
  expect(status.stdout).toContain("mcp: tools, connected, 3 tools")
  expect(status.stdout).toMatch(
    /mcp: legacy, failed \(SSE transport is not supported/,
  )

  // A secret mcp.json names rebuilds the layer and prints it, and one it does not name rebuilds nothing (MCP-40).
  const second = "second-91aa-not-in-env"
  const changed = await running.chad(
    ["secret", "set", "TOKEN"],
    {},
    second + "\n",
  )
  expect(changed.stdout).toContain("MCP server tools: connected, 3 tools.")
  const other = await running.chad(["secret", "set", "UNRELATED"], {}, "x\n")
  expect(other.stdout).not.toContain("MCP server")
  expect(
    results(
      (await turn(running, "console.log(await mcp.tools.token({}))"))[1],
    ).join("\n"),
  ).toContain(sha(second))
  for (const value of [canary, second]) {
    expect(Object.values(process.env)).not.toContain(value)
    expect(
      readFileSync(join(running.data, "logs/chad.log"), "utf8"),
    ).not.toContain(value)
  }

  // A relative cwd and a malformed file fail the check and the apply, and the servers stay as they were (MCP-33, MCP-110).
  write(work, {
    "mcp.json": mcpJson({ tools: { ...fixture(), cwd: "notes" } }),
  })
  for (const args of [["check"], ["apply", "-m", "Relative"]]) {
    const refused = await running.chad(args)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain(
      Messages.mcpRelativeCwdRefused("tools", "notes"),
    )
  }
  write(work, { "mcp.json": "{ not json" })
  const malformed = await apply(running, "Malformed")
  expect(malformed.code).toBe(1)
  expect(malformed.stderr).toContain("work/mcp.json: it is not JSON")
  expect((await running.chad(["status"])).stdout).toContain(
    "mcp: tools, connected, 3 tools",
  )
}, 60_000)
