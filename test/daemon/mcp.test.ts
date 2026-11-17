// MCP servers as the owner, the model and the CLI reach them: `mcp.json` checked, applied and rebuilt, `${NAME}` from
// the secret store, the calls the model makes while the layer rebuilds, a boot on a malformed or slow file, and the
// OAuth sign-in of an HTTP server, from the CLI and from chat.
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import type { ChatMessage, ChatThread } from "effect/chat"
import { expect, onTestFinished, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import * as Plugin from "../../dist/Plugin.js"
import requestMcpLogin from "../../dist/plugins/request-mcp-login/index.js"
import { write } from "../support/applied.ts"
import * as Cli from "../support/cli.ts"
import { owner, scenario, type Scenario } from "../support/driver.ts"
import { results, runs, type Call } from "../support/model.ts"
import * as OAuth from "../support/oauth.ts"
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

const needsLogin = (name: string) =>
  Messages.mcpServerLine({ name, state: "needs-login" })

/** The stored sign-ins, by server name. */
const signIns = (data: string): Record<string, Record<string, unknown>> =>
  JSON.parse(readFileSync(join(data, "secrets/mcp-oauth.json"), "utf8"))

/** Every file under a directory that holds one of the values, by its path relative to it. */
const holding = (
  root: string,
  values: ReadonlyArray<string>,
  under = "",
): ReadonlyArray<string> =>
  readdirSync(join(root, under), { withFileTypes: true }).flatMap((entry) => {
    const path = join(under, entry.name)
    if (entry.isDirectory()) return holding(root, values, path)
    if (!entry.isFile()) return []
    const text = readFileSync(join(root, path), "utf8")
    return values.some((value) => text.includes(value)) ? [path] : []
  })

test("an http server with an oauth key comes up needing a login and nothing unattended asks its authorization server, chad mcp login signs in with the client mcp.json names once the address carries its own state, the sign-in outlives a refresh and a restart, a revoked one fails the call and starts nothing, and a sign-out empties the store", async () => {
  const secret = "client-secret-canary-41c7"
  const fake = await OAuth.make({ client: { id: "chad-client", secret } })
  onTestFinished(fake.close)
  const running = await scenario()
  const work = join(running.data, "repo/work")
  expect(
    (await running.chad(["secret", "set", "SLACK_SECRET"], {}, secret + "\n"))
      .code,
  ).toBe(0)
  const redirect = "https://chad.example.com/oauth/callback"
  write(work, {
    "mcp.json": mcpJson({
      slack: {
        url: fake.url,
        oauth: {
          clientId: "chad-client",
          clientSecret: "${SLACK_SECRET}",
          redirectUrl: redirect,
          scopes: ["channels:read", "chat:write"],
        },
      },
      // The same server with no oauth key: its 401 says what to add, and chad asks no authorization server.
      plain: { url: fake.url },
    }),
  })
  const applied = await apply(running, "Add an OAuth server")
  expect(applied.code).toBe(0)
  expect(applied.stdout).toContain(needsLogin("slack"))
  expect(applied.stdout).toContain(Messages.mcpUnauthorized("plain"))
  const status = await running.chad(["status"])
  expect(status.stdout).toContain("mcp: slack, needs login")
  const first = await turn(running, undefined)
  expect(systemText(first[0])).toContain(Messages.mcpNeedsLogin("slack"))
  expect(fake.asked()).toEqual([])

  /** `chad mcp login` as the owner runs it: the link opened in a browser, and the address pasted at the prompt. */
  const signIn = async (pasted: (address: string) => string) => {
    const login = Cli.start(
      ["mcp", "login", "slack"],
      { CHAD_DATA: running.data },
      false,
    )
    await login.printed(Messages.mcpLoginOpen("slack", "").at(-1)!)
    const link = login
      .output()
      .split("\n")
      .find((line) => line.startsWith("http"))
    login.child.stdin!.end(pasted(await fake.approve(link!)) + "\n")
    return login.done
  }
  const denial = `error=access_denied&error_description=${secret}`
  // An address with another state is refused before its code is sent anywhere and before anything it says is
  // repeated, a refusal it carries included.
  const forged = await signIn(
    (address) => `${address.replace(/state=[^&]+/, "state=forged")}&${denial}`,
  )
  expect(forged.code).toBe(1)
  expect(forged.stderr).toContain(Messages.mcpLoginOtherState("slack"))
  expect(fake.exchanges()).toEqual([])
  // A refusal in an address of this sign-in is repeated without the client secret it quotes.
  const denied = await signIn((address) =>
    address.replace(/code=[^&]+/, denial),
  )
  expect(denied.code).toBe(1)
  expect(denied.stderr).toContain("access_denied: ${SLACK_SECRET}")
  // The authorization server refuses a code it did not give, in words that quote the client secret and the code.
  const refused = await signIn((address) =>
    address.replace(/code=[^&]+/, "code=code-canary-9d2e"),
  )
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("refused ${SLACK_SECRET}")
  expect(refused.stderr).not.toContain("code-canary-9d2e")

  const signed = await signIn((address) => address)
  expect(signed.stderr).toBe("")
  expect(signed.stdout).toContain(connected("slack", 1))
  expect(fake.authorizations().at(-1)).toMatchObject({
    client_id: "chad-client",
    redirect_uri: redirect,
    scope: "channels:read chat:write",
  })
  expect(fake.exchanges().at(-1)).toMatchObject({
    grant_type: "authorization_code",
    client_id: "chad-client",
    client_secret: secret,
    redirect_uri: redirect,
  })
  expect(fake.asked()).not.toContain("/register")

  // The access token ends under the running layer. The call refreshes it and goes through.
  fake.expire()
  const refreshed = await turn(running, tries("mcp.slack.echo({ x: 1 })"))
  expect(results(refreshed[1]).join("\n")).toContain('{"x":1}')
  expect(fake.exchanges().at(-1)).toMatchObject({
    grant_type: "refresh_token",
  })

  // The server refuses the token a refresh has just given. The call says what to ask, as the status, a rebuild and
  // the next prompt do, and the sign-in is kept for when the server takes it again.
  fake.reject(true)
  const rejected = await turn(running, tries("mcp.slack.echo({ x: 3 })"))
  expect(results(rejected[1]).join("\n")).toContain(
    Messages.mcpNeedsLogin("slack"),
  )
  expect((await running.chad(["status"])).stdout).toContain(
    "mcp: slack, needs login",
  )
  const rebuilt = await running.chad(["mcp", "restart"])
  expect(rebuilt.stdout).toContain(needsLogin("slack"))
  const told = await turn(running, undefined)
  expect(systemText(told[0])).toContain(Messages.mcpNeedsLogin("slack"))
  fake.reject(false)

  // A restart connects with the refreshed token, which is the only one the server still takes.
  expect(await running.stop()).toBe(0)
  const again = await scenario({ directory: running.directory })
  const up = await eventually(
    () => again.chad(["status"]),
    ({ stdout }) => !stdout.includes("mcp: slack, starting"),
  )
  expect(up.stdout).toContain("mcp: slack, connected, 1 tools")
  const asked = fake.authorizations().length

  // A sign-out the volume does not take leaves the owner signed in and says so: the store's temporary file cannot
  // be made where a directory has its name.
  const blocked = `${join(again.data, "secrets/mcp-oauth.json")}.${process.pid}.tmp`
  mkdirSync(blocked)
  const unsaved = await again.chad(["mcp", "logout", "slack"])
  expect(unsaved.code).toBe(1)
  expect(unsaved.stdout).not.toContain(Messages.mcpLoggedOut("slack"))
  expect(signIns(again.data)["slack"]).toHaveProperty("tokens")
  expect((await again.chad(["status"])).stdout).toContain(
    "mcp: slack, connected, 1 tools",
  )
  rmdirSync(blocked)

  // The owner revokes chad. The call fails with what to ask, and no sign-in is begun for it.
  fake.revoke()
  // The new chat fake counts its threads from the first again, and those four hold the sessions of the turns above.
  for (let made = 0; made < 4; made++)
    await again.fakes.chat.makeThread("direct")
  const revoked = await turn(again, tries("mcp.slack.echo({ x: 2 })"))
  expect(results(revoked[1]).join("\n")).toContain(
    Messages.mcpNeedsLogin("slack"),
  )
  const down = await again.chad(["status"])
  expect(down.stdout).toContain("mcp: slack, needs login")
  expect(signIns(again.data)["slack"]).not.toHaveProperty("pending")
  expect(fake.authorizations()).toHaveLength(asked)

  const out = await again.chad(["mcp", "logout", "slack"])
  expect(out.stdout).toContain(needsLogin("slack"))
  expect(signIns(again.data)).toEqual({})

  expect(await again.stop()).toBe(0)
  expect(holding(again.data, [secret])).toEqual(["secrets/secrets.json"])
  const shown = JSON.stringify([
    applied,
    status,
    forged,
    denied,
    refused,
    signed,
    rebuilt,
    unsaved,
    up,
    down,
    await Effect.runPromise(again.chat.calls),
    await again.fakes.model.calls(),
  ])
  for (const value of [secret, ...fake.issued()])
    expect(shown).not.toContain(value)
}, 60_000)

/** chad's message in a thread that holds the text, once it is posted. A notice may share the thread. */
const said = async (
  running: Scenario,
  thread: ChatThread.ChatThread,
  text: string,
) => {
  const holds = (message: ChatMessage.ChatMessage) =>
    message.author.isSelf && message.text.includes(text)
  const all = await eventually(
    () => running.fakes.chat.messages(thread),
    (messages) => messages.some(holds),
  )
  return all.find(holds)!
}

test("requestMcpLogin posts a button that only the owner's click begins a sign-in with and only the owner's form finishes, chad registers itself for an empty oauth key, a session's own shell signs in to nothing, and no token is in a file but the store, in the chat or in what the model sees", async () => {
  const fake = await OAuth.make()
  onTestFinished(fake.close)
  const running = await scenario({
    plugins: [{ name: "request-mcp-login", plugin: requestMcpLogin }],
  })
  const { fakes } = running
  await running.logged("boot.ready")
  write(join(running.data, "repo/work"), {
    "mcp.json": mcpJson({
      linear: { url: fake.url, oauth: {} },
      // Its scopes make a link that fits in no button and in no message.
      wide: {
        url: fake.url,
        oauth: {
          scopes: Array.from(
            { length: 80 },
            (_, index) => `scope:${index}:${"x".repeat(20)}`,
          ),
        },
      },
    }),
  })
  const applied = await apply(running, "Add an OAuth server")
  expect(applied.stdout).toContain(needsLogin("linear"))

  await fakes.model.script([
    runs(
      `console.log(await requestMcpLogin({ server: "linear" }), await requestMcpLogin({ server: "wide" }))`,
    ),
    { text: "Press the button." },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "what is on my board?")
  const request = await said(running, thread, "`linear`")
  const wide = await said(running, thread, "`wide`")

  // Neither a stranger's click nor the agent's own shell begins a sign-in.
  expect(
    (await Effect.runPromise(running.click(request.id, "mcp-login", "mallory")))
      ._tag,
  ).toBe("Ack")
  const shell = await running.chad(["mcp", "login", "linear"], {
    CHAD_SESSION: "s1",
  })
  expect(shell.code).toBe(3)
  expect(fake.asked()).toEqual([])

  // A sign-out while a sign-in still waits on the server ends that sign-in: the registration that comes back to it
  // afterwards is dropped, and no link is posted for it.
  const release = fake.hold("/register")
  await Effect.runPromise(running.click(request.id, "mcp-login", owner))
  await eventually(
    () => fake.asked(),
    (paths) => paths.includes("/register"),
  )
  expect((await running.chad(["mcp", "logout", "linear"])).code).toBe(0)
  release()
  await said(running, thread, Messages.mcpLoginReplaced("linear"))
  expect(signIns(running.data)).toEqual({})
  expect(running.links()).toEqual([])

  await Effect.runPromise(running.click(request.id, "mcp-login", owner))
  const steps = await said(running, thread, Messages.mcpLoginSteps("linear"))
  expect(fake.registrations()).toHaveLength(2)
  const address = await fake.approve(running.links().at(-1)!)
  expect(fake.authorizations().at(-1)).toMatchObject({
    client_id: "registered-2",
  })

  // A stranger opens no form, and a form a stranger submits finishes nothing: a command behind it in the daemon's
  // queue finds the server as it was, and the code unused.
  const stranger = await Effect.runPromise(
    running.submit(
      steps.id,
      "mcp-login-paste",
      { clicker: "mallory", submitter: "mallory" },
      { address },
    ),
  )
  expect(stranger.clicked._tag).toBe("Ack")
  const other = await Effect.runPromise(
    running.submit(
      steps.id,
      "mcp-login-paste",
      { clicker: owner, submitter: "mallory" },
      { address },
    ),
  )
  expect(other.submitted?._tag).toBe("Close")
  const still = await running.chad(["mcp", "restart"])
  expect(still.stdout).toContain(needsLogin("linear"))
  expect(fake.exchanges()).toEqual([])
  const filled = await Effect.runPromise(
    running.submit(
      steps.id,
      "mcp-login-paste",
      { clicker: owner, submitter: owner },
      { address },
    ),
  )
  expect(filled.submitted?._tag).toBe("Close")
  const done = await said(
    running,
    thread,
    Format.local.subtext(Messages.mcpLoggedIn("linear")),
  )
  expect(done.text).toContain(Format.local.subtext(connected("linear", 1)))
  expect(fake.exchanges()).toHaveLength(1)

  const used = await turn(running, tries("mcp.linear.echo({ x: 1 })"))
  expect(results(used[1]).join("\n")).toContain('{"x":1}')
  const status = await running.chad(["status"])
  expect(status.stdout).toContain("mcp: linear, connected, 1 tools")
  const store = join(running.data, "secrets/mcp-oauth.json")
  expect(statSync(store).mode & 0o777).toBe(0o600)

  // A link that fits in no message is not posted, and the owner is told the way in that prints it.
  await Effect.runPromise(running.click(wide.id, "mcp-login", owner))
  await said(running, thread, Messages.mcpLoginUnposted("wide", true))
  expect(running.links()).toHaveLength(1)

  // The scan reads the daemon's lock file, which a running daemon in this process would lose its lock by.
  expect(await running.stop()).toBe(0)
  expect(holding(running.data, fake.issued())).toEqual([
    "secrets/mcp-oauth.json",
  ])
  const shown = JSON.stringify([
    applied,
    status,
    await Effect.runPromise(running.chat.calls),
    await fakes.model.calls(),
  ])
  for (const value of fake.issued()) expect(shown).not.toContain(value)
  expect(shown).not.toContain(address)
}, 60_000)
