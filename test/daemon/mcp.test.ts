// MCP servers as the owner, the model and the CLI reach them: `mcp.json` checked, applied and rebuilt, `${NAME}` from
// the secret store, the calls the model makes while the layer rebuilds, and a boot on a malformed or slow file.
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
import { Effect, Layer } from "effect"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import { applied as committed, write } from "../support/applied.ts"
import * as Cli from "../support/cli.ts"
import { fresh, scenario, type Scenario } from "../support/driver.ts"
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

/** Each server's line once a rebuild ends. */
const connected = (name: string, tools: number) =>
  Messages.mcpServerLine({ name, state: "connected", tools })
const unavailable = (name: string, error: string) =>
  Messages.mcpServerLine({ name, state: "failed", error })

/** What a message says before the text it is given. */
const before = (message: (text: string) => string) =>
  message("\u0000").split("\u0000")[0] ?? ""

const apply = (running: Scenario, message: string) =>
  running.chad(["apply", "-m", message])

/** A plugin whose settings name TOKEN, and whose build waits while `gate` is set. */
const gated = () => {
  const state = { builds: 0, gate: undefined as Promise<void> | undefined }
  const plugin = Plugin.make(
    Layer.effectDiscard(
      Effect.gen(function* () {
        state.builds++
        const gate = state.gate
        if (gate !== undefined) yield* Effect.promise(() => gate)
      }),
    ),
  )
  return { state, plugin }
}

const count = (running: Scenario, event: string) =>
  running.log().filter((line) => line.annotations["event"] === event).length

test("an applied mcp.json connects its servers with names from the secret store that never reach the environment or any output, a failed or unavailable server does not block the apply, a secret it names rebuilds it, and a malformed file or a relative cwd fails the check and the apply", async () => {
  const held = gated()
  const running = await scenario({
    plugins: [{ name: "held", plugin: held.plugin }],
  })
  const work = join(running.data, "repo/work")
  const canary = "canary-7f3e-not-in-env"
  expect(
    (await running.chad(["secret", "set", "TOKEN"], {}, canary + "\n")).code,
  ).toBe(0)
  // A value made of the log's own syntax, which a scrub of the serialized line would break it on.
  const punct = '":"'
  expect(
    (await running.chad(["secret", "set", "PUNCT"], {}, punct + "\n")).code,
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
      // The spawn's error quotes the command, which here is the secret.
      typo: { command: "${TOKEN}" },
      punct: { command: "${PUNCT}" },
      dropping: fixture("--tools", "quit"),
    }),
    "chad.json":
      JSON.stringify({
        plugins: { held: { settings: { token: "${TOKEN}" } } },
      }) + "\n",
  })
  // A check connects nothing, names what an apply adds and warns of the name that resolves nowhere.
  const check = await running.chad(["check"])
  expect(check.code).toBe(0)
  for (const line of Messages.mcpCheckLines({
    added: [
      "tools",
      "broken",
      "missing",
      "legacy",
      "typo",
      "punct",
      "dropping",
    ],
    removed: [],
    changed: [],
  }))
    expect(check.stdout).toContain(line)
  expect(check.stdout).toContain(
    Messages.mcpCheckUnresolved("missing", "NOPE_NOT_SET"),
  )

  // The apply prints its commit line first, then each server once the layer is current.
  const applied = await apply(running, "Add MCP servers")
  expect(applied.code).toBe(0)
  const out = applied.stdout.split("\n")
  const at = (text: string) => out.findIndex((line) => line.startsWith(text))
  expect(at(connected("tools", 3))).toBeGreaterThan(0)
  expect(out.at(-1) === "" ? out.at(-2) : out.at(-1)).toBe(
    Messages.appliedClosing,
  )
  expect(at(unavailable("broken", "").trimEnd())).toBeGreaterThan(0)
  expect(applied.stdout).toContain(
    unavailable("missing", Messages.mcpUnresolved("NOPE_NOT_SET")),
  )
  expect(applied.stdout).toContain(unavailable("legacy", Messages.mcpSse))
  expect(applied.stdout).toContain("spawn ${TOKEN} ENOENT")
  expect(applied.stdout).not.toContain(canary)

  // The model calls the server. The token reached it from the store, and it runs in HOME as the daemon.
  const calls = await turn(
    running,
    "console.log(await mcp.tools.echo({ x: 1 })); console.log(await mcp.tools.token({})); console.log(await mcp.tools.cwd({})); console.log(await mcp.dropping.quit({}))",
  )
  expect(systemText(calls[0])).toContain("- tools (3 tools)")
  expect(systemText(calls[0])).toContain("- broken: failed to connect")
  expect(systemText(calls[0])).toContain("spawn ${TOKEN} ENOENT")
  expect(systemText(calls[0])).not.toContain(canary)
  const printed = results(calls[1]).join("\n")
  expect(printed).toContain('{"x":1}')
  expect(printed).toContain(`${sha(canary)} daemon`)
  expect(printed).toContain(`\n${process.env["HOME"]}\n`)

  // A server that exits after it connected shows as it is now, not as it connected.
  const status = await eventually(
    () => running.chad(["status"]),
    ({ stdout }) => !stdout.includes("mcp: dropping, connected"),
  )
  expect(status.stdout).toContain("mcp: tools, connected, 3 tools")
  expect(status.stdout).toContain(`mcp: legacy, failed (${Messages.mcpSse})`)
  expect(status.stdout).toContain(
    "mcp: dropping, failed (disconnected: connection closed)",
  )
  expect(status.stdout).not.toContain(canary)

  // A secret mcp.json names rebuilds the layer and prints it, and one it does not name rebuilds nothing.
  const second = "second-91aa-not-in-env"
  const changed = await running.chad(
    ["secret", "set", "TOKEN"],
    {},
    second + "\n",
  )
  expect(changed.stdout).toContain(connected("tools", 3))
  const other = await running.chad(["secret", "set", "UNRELATED"], {}, "x\n")
  expect(other.stdout).not.toContain(connected("tools", 3))
  expect(
    results(
      (await turn(running, "console.log(await mcp.tools.token({}))"))[1],
    ).join("\n"),
  ).toContain(sha(second))

  // A CLI killed once the store is written, while a plugin that names the secret rebuilds, still leaves the change its
  // MCP rebuild.
  const third = "third-5b0d-not-in-env"
  let release = () => {}
  held.state.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const builds = held.state.builds
  const rebuilt = count(running, "mcp.rebuilt")
  const killed = Cli.start(
    ["secret", "set", "TOKEN"],
    { CHAD_DATA: running.data },
    third + "\n",
  )
  await eventually(
    () => held.state.builds,
    (now) => now > builds,
  )
  killed.child.kill("SIGKILL")
  await killed.done
  held.state.gate = undefined
  release()
  await lines(running, "mcp.rebuilt", rebuilt + 1)
  expect(
    results(
      (await turn(running, "console.log(await mcp.tools.token({}))"))[1],
    ).join("\n"),
  ).toContain(sha(third))

  // A relative cwd and a malformed file fail the check and the apply, and the servers stay as they were.
  write(work, {
    "mcp.json": mcpJson({
      tools: { ...fixture(), cwd: "notes" },
      hidden: { ...fixture(), cwd: "${TOKEN}" },
    }),
  })
  for (const args of [["check"], ["apply", "-m", "Relative"]]) {
    const refused = await running.chad(args)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain(
      Messages.mcpRelativeCwdRefused("tools", "notes"),
    )
    expect(refused.stderr).toContain(
      Messages.mcpRelativeCwdRefused("hidden", "${TOKEN}"),
    )
    expect(refused.stdout + refused.stderr).not.toContain(third)
  }
  write(work, { "mcp.json": "{ not json" })
  const malformed = await apply(running, "Malformed")
  expect(malformed.code).toBe(1)
  expect(malformed.stderr).toContain(
    before((error) => Messages.mcpRefused(Messages.mcpNotJson(error))),
  )
  expect((await running.chad(["status"])).stdout).toContain(
    "mcp: tools, connected, 3 tools",
  )
  // Every line of the log still parses, and clanka's line for the failed spawn says ${PUNCT} where its value was, with
  // its keys as they were.
  const entries = readFileSync(join(running.data, "logs/chad.log"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map(
      (line) =>
        JSON.parse(line) as {
          message: unknown
          annotations: Record<string, unknown>
        },
    )
  const spawned = entries.filter(
    ({ annotations }) => annotations["server"] === "punct",
  )
  expect(
    spawned.some(({ annotations }) =>
      String(annotations["error"]).includes("spawn ${PUNCT} ENOENT"),
    ),
  ).toBe(true)
  for (const { message, annotations } of spawned)
    for (const value of [message, ...Object.values(annotations)])
      expect(String(value)).not.toContain(punct)
  // No value reached the environment or the log, failed spawns and refusals included.
  for (const value of [canary, second, third]) {
    expect(Object.values(process.env)).not.toContain(value)
    expect(
      readFileSync(join(running.data, "logs/chad.log"), "utf8"),
    ).not.toContain(value)
  }
}, 60_000)

/** A script that prints what each call gave, or what it failed with. */
const tries = (...calls: ReadonlyArray<string>) =>
  calls
    .map(
      (call) =>
        `try { console.log(String(await ${call})) } catch (error) { console.log(String(error?.message ?? error)) }`,
    )
    .join("\n")

test("a running turn's call in flight is cut by a restart, a call during the rebuild is not sent, and once a new layer is current the turn's old keys are routed to it and words what is gone", async () => {
  const running = await scenario()
  const { fakes } = running
  const work = join(running.data, "repo/work")
  const mark = join(running.directory, "mark")
  const gate = join(running.directory, "gate")
  mkdirSync(mark, { recursive: true })
  const slow = (tools: string) =>
    fixture("--tools", tools, "--mark", mark, "--gate", gate)
  write(work, {
    "mcp.json": mcpJson({
      slow: slow("hang,echo"),
      other: fixture("--tools", "ping"),
    }),
  })
  expect((await apply(running, "Add MCP servers")).code).toBe(0)

  await fakes.model.script([
    runs(tries("mcp.slow.hang({})")),
    runs(tries("mcp.slow.echo({ x: 2 })")),
    {
      ...runs(
        tries(
          "mcp.slow.echo({ x: 3 })",
          "mcp.slow.hang({})",
          "mcp.other.ping({})",
          'searchTools({ server: "slow" })',
        ),
      ),
      hold: true,
    },
    { text: "ok" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "go")
  await eventually(() => existsSync(join(mark, "hang")), Boolean)

  // The restart cuts the call in flight at once, and a call while the new layer connects is not sent.
  writeFileSync(gate, "")
  const restart = Cli.start(["mcp", "restart"], { CHAD_DATA: running.data })
  const calls = await fakes.model.received(3)
  expect(results(calls[1]).join("\n")).toContain(
    Messages.mcpInterrupted("slow.hang"),
  )
  expect(results(calls[2]).at(-1)).toContain(Messages.mcpRestarting)
  rmSync(gate)
  const restarted = await restart.done
  expect(restarted).toMatchObject({ code: 0 })
  expect(restarted.stdout).toContain(connected("slow", 2))

  // An apply drops a server and a tool and adds a tool while the turn runs. Its old keys reach the new layer.
  write(work, { "mcp.json": mcpJson({ slow: slow("echo,fresh") }) })
  expect((await apply(running, "Drop other")).code).toBe(0)
  await fakes.model.release(2)
  await running.logged("turn.ended")
  const last = results((await fakes.model.calls())[3]).at(-1) ?? ""
  expect(last).toContain('{"x":3}')
  expect(last).toContain(Messages.mcpToolGone("slow.hang", "slow"))
  expect(last).toContain(Messages.mcpRemoved("other.ping", "other"))
  expect(last).toContain(`\n\n${Messages.mcpNextTurn(["slow.fresh"])}`)

  // The next turn takes the new layer.
  const next = await turn(running, tries("mcp.slow.fresh({})"))
  expect(systemText(next[0])).toContain("- slow (2 tools)")
  expect(systemText(next[0])).not.toContain("- other")
  expect(results(next[1]).join("\n")).toContain("fresh")
}, 60_000)

test("a malformed applied mcp.json boots with no servers and a notice that an apply clears, a turn before the first connect has message 7 and no MCP, and safe mode loads no server", async () => {
  const directory = fresh()
  const gate = join(directory, "gate")
  committed(join(directory, "data/repo"), {
    "mcp.json": "{ nope",
    "persona.md": "",
  })
  const first = await scenario({ directory })
  await first.logged("mcp.config-unreadable")
  // The second boot's chat fake numbers its messages from the start again, so this boot takes no message.
  const broken = (await first.chad(["status"])).stdout
  const unreadable = before((error) =>
    Messages.mcpUnreadable(Messages.mcpNotJson(error)),
  )
  expect(broken).toContain(unreadable)
  expect(broken).not.toContain("mcp: ")

  write(join(first.data, "repo/work"), {
    "mcp.json": mcpJson({ slow: fixture("--tools", "echo", "--gate", gate) }),
  })
  expect((await apply(first, "Fix mcp.json")).code).toBe(0)
  expect((await first.chad(["status"])).stdout).not.toContain(unreadable)
  expect(await first.stop()).toBe(0)

  // A boot is a rebuild in the background: a turn before the first layer connects starts without MCP.
  writeFileSync(gate, "")
  const second = await scenario({ directory })
  // The log goes on from the first daemon's, so this boot is the second boot.ready in it.
  await lines(second, "boot.ready", 2)
  const rebuilt = second
    .log()
    .filter((line) => line.annotations["event"] === "mcp.rebuilt").length
  const early = systemText((await turn(second, undefined))[0])
  expect(early).toContain(Messages.mcpStarting)
  expect(early).not.toContain("# MCP servers")
  rmSync(gate)
  await lines(second, "mcp.rebuilt", rebuilt + 1)
  expect(systemText((await turn(second, undefined))[0])).toContain(
    "- slow (1 tools)",
  )

  // Safe mode stops every server, and safe off brings them back.
  expect((await second.chad(["safe", "on"])).stdout).not.toContain(
    connected("slow", 1),
  )
  expect((await second.chad(["status"])).stdout).not.toContain("mcp: slow")
  expect(systemText((await turn(second, undefined))[0])).not.toContain("- slow")
  expect((await second.chad(["safe", "off"])).stdout).toContain(
    connected("slow", 1),
  )
}, 60_000)
