// The stored chat connections, their owners and their channels that need no mention, through the `chad connection`,
// `chad owner` and `chad channel` commands: with no
// daemon, where the CLI writes the file itself, and with the daemon running, where the change applies at once.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Duration, Effect, Layer } from "effect"
import { ChatError } from "effect/chat"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { expect, onTestFinished, test } from "vitest"
import * as Constants from "../../dist/Discord.js"
import * as Lock from "../../dist/Lock.js"
import * as Messages from "../../dist/Messages.js"
import { Rpcs } from "../../dist/Rpcs.js"
import { version } from "../../dist/Version.js"
import * as Cli from "../support/cli.ts"
import * as Discord from "../support/discord.ts"
import {
  fresh,
  httpClient,
  inProcess,
  type Scenario,
  scenario,
} from "../support/driver.ts"
import { lines, posted, says } from "../support/owner.ts"

const owner = "700000000000000001"
const home = {
  name: "home",
  kind: "discord" as const,
  token: "home-token",
  owners: [owner],
}

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

/** What `secrets/connections.json` of a volume holds. */
const stored = (data: string) =>
  JSON.parse(readFileSync(join(data, "secrets/connections.json"), "utf8"))

/** A volume no daemon has run on, a fake Discord REST server, and the two ways a scenario runs `chad` on them. */
const volume = async () => {
  const directory = fresh()
  const data = join(directory, "data")
  mkdirSync(data, { recursive: true })
  const rest = await Discord.rest()
  onTestFinished(async () => {
    await rest.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const env = { CHAD_DATA: data }
  const client = httpClient({ model: rest.url, discord: rest.url })
  return {
    directory,
    data,
    rest,
    lock: join(data, "state/daemon.lock"),
    /** The real bin, as the owner's shell runs it. */
    chad: (args: ReadonlyArray<string>, more = {}, input?: string) =>
      Cli.chad(args, { ...env, ...more }, input),
    /** `runCli` in this process, for a command that asks Discord by itself. */
    cli: (args: ReadonlyArray<string>) => inProcess(args, client, env),
  }
}

let files = 0
/** A file that holds a token. */
const tokenFile = (directory: string, token: string) => {
  const file = join(directory, `token-${++files}`)
  writeFileSync(file, token + "\n", { mode: 0o600 })
  return file
}

const done = (stdout: ReadonlyArray<string>) => ({
  stdout: stdout.map((line) => line + "\n").join(""),
  stderr: "",
  code: 0,
})

const failed = (code: number, message: string) => ({
  stdout: "",
  stderr: message + "\n",
  code,
})

/** The lines `chad connection add discord` prints for the fake's application. */
const addedDiscord = (name: string) => [
  Messages.connectionAdded(name, "discord"),
  Messages.connectionInvite(Constants.inviteUrl(Discord.application)),
  Messages.connectionIntents(Constants.privilegedIntentNames),
]

/** Plays Discord's side of a fresh identify on the daemon's socket number `index`. */
const identify = async (chad: Scenario, index: number, session: string) => {
  const socket = await chad.discord.gateway.socket(index)
  socket.receive(Discord.hello)
  const [identified] = await socket.sent(Discord.Op.identify, 1)
  socket.receive(Discord.ready(1, session))
  return { socket, identified }
}

/** The `command.ran` lines of a scenario, as the fields the event carries. */
const ran = (chad: Scenario) =>
  chad
    .log()
    .filter((line) => line.annotations["event"] === "command.ran")
    .map(({ annotations }) => ({
      command: annotations["command"],
      caller: annotations["caller"],
      outcome: annotations["outcome"],
      connection: annotations["connection"],
      ...(annotations["reason"] === undefined
        ? {}
        : { reason: annotations["reason"] }),
    }))

test("with no daemon the connection and owner commands write secrets/connections.json themselves, before any daemon or database exists: a format number and a list that holds two bots of one platform and a local connection with no token", async () => {
  const { directory, data, rest, chad, cli } = await volume()
  const umask = process.umask()

  expect(await chad(["connection", "add", "local"])).toEqual(
    done([Messages.connectionAdded("local", "local")]),
  )
  // A connection's name defaults to its platform, and a second bot of the platform gets a name of its own.
  expect(
    await cli([
      "connection",
      "add",
      "discord",
      "--token-file",
      tokenFile(directory, "home-token"),
    ]),
  ).toEqual(done(addedDiscord("discord")))
  expect(
    await cli([
      "connection",
      "add",
      "discord",
      "--name",
      "work",
      "--token-file",
      tokenFile(directory, "work-token"),
    ]),
  ).toEqual(done(addedDiscord("work")))
  expect(await chad(["owner", "add", "work", owner])).toEqual(
    done([Messages.ownerAdded(owner, "work")]),
  )
  expect(await chad(["owner", "add", "local", "ada"])).toEqual(
    done([Messages.ownerAdded("ada", "local")]),
  )

  // A name is lower-case letters, digits and hyphens and is taken once, and one local connection is all there is.
  const refused = (
    reason: "name-invalid" | "name-taken" | "second-local",
    name: string,
  ) =>
    failed(
      1,
      Messages.connectionRejected("connection add", {
        reason,
        name,
        detail: "",
      }),
    )
  for (const name of ["Work", "work/2", "work_2", "work 2"]) {
    expect(await chad(["connection", "add", "local", "--name", name])).toEqual(
      refused("name-invalid", name),
    )
  }
  expect(
    await chad(["connection", "add", "discord", "--name", "work"], {}, "x"),
  ).toEqual(refused("name-taken", "work"))
  expect(
    await chad(["connection", "add", "local", "--name", "local-2"]),
  ).toEqual(refused("second-local", "local"))

  expect(await chad(["connection", "list"])).toEqual(
    done([
      Messages.connectionLine("local", "local", ["ada"]),
      Messages.connectionLine("discord", "discord", []),
      Messages.connectionLine("work", "discord", [owner]),
    ]),
  )
  expect(stored(data)).toEqual({
    format: 1,
    connections: [
      { name: "local", kind: "local", owners: ["ada"] },
      { name: "discord", kind: "discord", token: "home-token", owners: [] },
      { name: "work", kind: "discord", token: "work-token", owners: [owner] },
    ],
  })
  // The local connection took no token, so Discord was asked about the two bots and nothing else.
  expect(
    rest.calls().map((call) => [call.path, call.headers["authorization"]]),
  ).toEqual([
    ["/applications/@me", "Bot home-token"],
    ["/applications/@me", "Bot work-token"],
  ])

  const file = join(data, "secrets/connections.json")
  expect(mode(join(data, "secrets"))).toBe("700")
  expect(mode(file)).toBe("600")
  expect(statSync(file).uid).toBe(process.getuid?.())
  expect(process.umask()).toBe(umask)
  // No daemon ran and none was needed: there is no database and no socket.
  expect(existsSync(join(data, "db"))).toBe(false)
  expect(existsSync(join(data, "run"))).toBe(false)
})

test("the CLI holds no lock while it waits, takes it for the write, and writes nothing when a daemon took the lock first", async () => {
  const { directory, data, rest, lock, chad, cli } = await volume()
  expect((await chad(["connection", "add", "local"])).code).toBe(0)
  const before = stored(data)
  const add = [
    "connection",
    "add",
    "discord",
    "--token-file",
    tokenFile(directory, "slow-token"),
  ]

  const release = rest.hold("slow-token")
  const adding = cli(add)
  await rest.called("GET", /^\/applications\/@me$/)
  // The token is read and Discord is being asked. A daemon that starts now gets the lock.
  expect(Lock.test(lock)).toBe("free")
  const daemon = Lock.take(lock, Duration.zero)
  expect(daemon).toBeDefined()
  release()
  expect(await adding).toEqual(
    failed(1, Messages.daemonStarted("connection add")),
  )
  expect(stored(data)).toEqual(before)

  daemon?.()
  expect((await cli(add)).code).toBe(0)
  expect(stored(data).connections).toHaveLength(2)
})

test("with no daemon, a CLI that is older than the version in state/version refuses to write with exit 1 and still reads, and it looks again once it holds the lock", async () => {
  const { directory, data, rest, chad, cli } = await volume()
  expect((await chad(["connection", "add", "local"])).code).toBe(0)
  mkdirSync(join(data, "state"), { recursive: true })
  writeFileSync(join(data, "state/version"), "999.0.0\n")
  const before = stored(data)

  expect(await chad(["owner", "add", "local", "ada"])).toEqual(
    failed(1, Messages.cliOlder("owner add", version, "999.0.0")),
  )
  expect(await chad(["connection", "remove", "local", "--force"])).toEqual(
    failed(1, Messages.cliOlder("connection remove", version, "999.0.0")),
  )
  expect(stored(data)).toEqual(before)
  expect(await chad(["connection", "list"])).toEqual(
    done([Messages.connectionLine("local", "local", [])]),
  )

  // Something that is no version is refused as well, because nothing says this CLI is new enough.
  writeFileSync(join(data, "state/version"), "tuesday\n")
  expect(await chad(["owner", "add", "local", "ada"])).toEqual(
    failed(1, Messages.cliOlder("owner add", version, "tuesday")),
  )

  // The volume's own version writes.
  writeFileSync(join(data, "state/version"), version + "\n")
  expect((await chad(["owner", "add", "local", "ada"])).code).toBe(0)

  // A newer daemon starts and stops while the CLI waits for Discord. The first check passed, and the write is
  // still refused.
  const waiting = stored(data)
  const release = rest.hold("slow-token")
  const adding = cli([
    "connection",
    "add",
    "discord",
    "--token-file",
    tokenFile(directory, "slow-token"),
  ])
  await rest.called("GET", /^\/applications\/@me$/)
  writeFileSync(join(data, "state/version"), "999.0.0\n")
  release()
  expect(await adding).toEqual(
    failed(1, Messages.cliOlder("connection add", version, "999.0.0")),
  )
  expect(stored(data)).toEqual(waiting)
})

test("with CHAD_SESSION set, whatever its value, the CLI refuses every connection and owner command with exit 3 and a line that names the command and the owner, the other commands stay open, and the same command with the variable unset is accepted", async () => {
  const { data, chad } = await volume()
  const commands = [
    ["connection add", "connection", "add", "local"],
    ["connection add", "connection", "add", "discord"],
    ["connection list", "connection", "list"],
    ["connection check", "connection", "check"],
    ["connection token", "connection", "token", "local"],
    ["connection remove", "connection", "remove", "local", "--force"],
    ["owner add", "owner", "add", "local", "ada"],
    ["owner remove", "owner", "remove", "local", "ada", "--force"],
    ["channel add", "channel", "add", "local", "general"],
    ["channel remove", "channel", "remove", "local", "general"],
  ]
  for (const session of ["daemon", "0b4b1c9e-55d0-4d0c-9f0a-3e8f0f7f2a11"]) {
    const refused = await Promise.all(
      commands.map(([, ...args]) => chad(args, { CHAD_SESSION: session }, "")),
    )
    expect(refused).toEqual(
      commands.map(([command]) =>
        failed(3, Messages.ownerRefused(command!, session)),
      ),
    )
  }
  // The refusal wrote nothing.
  expect(existsSync(join(data, "secrets"))).toBe(false)

  // A command that is no owner command is not refused: with no daemon these two end as they do for the owner.
  for (const command of ["health", "status"]) {
    expect(
      (await chad([command], { CHAD_SESSION: "daemon" })).code,
      command,
    ).toBe(4)
  }

  // It is no boundary: a session's shell that unsets the variable runs the command.
  expect(
    await chad(["connection", "add", "local"], { CHAD_SESSION: undefined }),
  ).toEqual(done([Messages.connectionAdded("local", "local")]))
})

test("with the daemon running the daemon checks a token against Discord and swaps that connection's gateway with no restart: a new bot dials in with the intents of the one constant the invite URL is built from, a token Discord refuses leaves the old one in place, and a new token closes the old gateway and opens another", async () => {
  const chad = await scenario({ connections: [home] })
  const first = await identify(chad, 0, "session-home")
  const checks = () =>
    chad.discord.rest
      .calls()
      .filter((call) => call.path === "/applications/@me")
      .map((call) => call.headers["authorization"])
  // The scenario's own setup, made with no daemon, asked Discord through the CLI's client.
  expect(checks()).toEqual(["Bot home-token"])

  // The token comes on stdin, which is no terminal here.
  const added = await chad.chad(
    ["connection", "add", "discord", "--name", "work"],
    {},
    "work-token\n",
  )
  expect(added).toEqual(done(addedDiscord("work")))
  expect(checks()).toEqual(["Bot home-token", "Bot work-token"])
  // The invite is Discord's authorize URL for the bot's application, with the two scopes and the permissions of
  // the one list, and the intents named beside it are the privileged ones of the list the bots identify with.
  const invite = new URL(Constants.inviteUrl(Discord.application))
  expect(invite.origin + invite.pathname).toBe(
    "https://discord.com/oauth2/authorize",
  )
  expect(Object.fromEntries(invite.searchParams)).toEqual({
    client_id: Discord.application,
    scope: "bot applications.commands",
    permissions: String(Constants.permissions),
  })
  const second = await identify(chad, 1, "session-work")
  expect(second.identified).toMatchObject({
    token: "work-token",
    intents: Constants.intents,
  })
  expect(first.identified?.["intents"]).toBe(Constants.intents)
  // Message content is the only privileged intent of the list.
  expect(Constants.privilegedIntents).toBe(1 << 15)
  expect(Constants.intents & Constants.privilegedIntents).toBe(1 << 15)
  expect(Constants.privilegedIntentNames).toHaveLength(1)
  await chad.logged(
    "chat.connected",
    (line) => line.annotations["connection"] === "work",
  )
  expect((await chad.chad(["status"])).stdout).toContain(
    "connection: work (discord)\n",
  )

  // A token Discord refuses changes nothing: the file keeps the old token and the old gateway stays open.
  chad.discord.rest.refuse("bad-token")
  expect(
    await chad.chad(["connection", "token", "home"], {}, "bad-token\n"),
  ).toEqual(
    failed(
      1,
      Messages.connectionRejected("connection token", {
        reason: "token-refused",
        name: "home",
        detail: "401",
      }),
    ),
  )
  // Neither does a token Discord gives no verdict on.
  chad.discord.rest.refuse("flaky-token", 503)
  expect(
    await chad.chad(["connection", "token", "home"], {}, "flaky-token\n"),
  ).toEqual(
    failed(
      1,
      Messages.connectionRejected("connection token", {
        reason: "token-unchecked",
        name: "home",
        detail: "503",
      }),
    ),
  )
  expect(stored(chad.data).connections[0]).toMatchObject({
    name: "home",
    token: "home-token",
  })
  expect(first.socket.closed).toBeUndefined()

  // A token that passes takes the old one's place at once.
  const file = tokenFile(chad.directory, "new-token")
  expect(
    await chad.chad(["connection", "token", "home", "--token-file", file]),
  ).toEqual(done([Messages.connectionToken("home")]))
  expect((await first.socket.ended()).by).toBe("chad")
  const swapped = await chad.discord.gateway.socket(2)
  swapped.receive(Discord.hello)
  expect(await swapped.sent(Discord.Op.resume, 1)).toMatchObject([
    { token: "new-token" },
  ])
  expect(second.socket.closed).toBeUndefined()
  expect(stored(chad.data).connections[0]).toMatchObject({
    name: "home",
    token: "new-token",
  })
})

test("an owner added to a local connection with chad owner add is answered at once, one that is removed is ignored at once, the list is by id with no flag for bots, and the last owner and the last connection go only with --force", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "Hello Grace." }])
  const thread = await fakes.chat.makeThread("direct")
  const post = async (text: string) =>
    fakes.chat.deliver(
      await fakes.chat.userPosts(thread, { text, authorId: "grace" }),
    )
  const ignored = () =>
    running
      .log()
      .filter((line) => line.annotations["event"] === "message.ignored")

  // The scenario's owner was added with chad owner add before the daemon started, and grace is not on the list.
  expect(await post("one")).toBe(true)
  await running.logged("message.ignored")

  expect(await running.chad(["owner", "add", "local", "grace"])).toEqual(
    done([Messages.ownerAdded("grace", "local")]),
  )
  expect(await post("two")).toBe(true)
  await fakes.chat.answers(thread, 1)
  expect(ignored()).toHaveLength(1)
  // An id that is on the list already changes nothing, and neither does one that is off it.
  expect(await running.chad(["owner", "add", "local", "grace"])).toEqual(
    done([Messages.ownerListed("grace", "local")]),
  )
  expect(await running.chad(["owner", "remove", "local", "mallory"])).toEqual(
    done([Messages.ownerUnlisted("mallory", "local")]),
  )
  // There is no flag for a bot.
  expect(
    (await running.chad(["owner", "add", "local", "helper-bot", "--bot"])).code,
  ).toBe(2)

  expect(await running.chad(["owner", "remove", "local", "grace"])).toEqual(
    done([Messages.ownerRemoved("grace", "local")]),
  )
  expect(await post("three")).toBe(true)
  await running.logged(
    "message.ignored",
    (line) => line.timestamp !== ignored()[0]?.timestamp,
  )
  expect(await fakes.model.calls()).toHaveLength(1)

  // The last owner id and the last connection need --force.
  expect(await running.chad(["owner", "remove", "local", "owner"])).toEqual(
    failed(
      1,
      Messages.connectionRejected("owner remove", {
        reason: "last-owner",
        name: "local",
        detail: "owner",
      }),
    ),
  )
  expect(await running.chad(["connection", "remove", "local"])).toEqual(
    failed(
      1,
      Messages.connectionRejected("connection remove", {
        reason: "last-connection",
        name: "local",
        detail: "",
      }),
    ),
  )
  expect(
    await running.chad(["owner", "remove", "local", "owner", "--force"]),
  ).toEqual(done([Messages.ownerRemoved("owner", "local")]))
  expect(
    await running.chad(["connection", "remove", "local", "--force"]),
  ).toEqual(done([Messages.connectionRemoved("local")]))
  expect(await running.chad(["connection", "list"])).toEqual(
    done([Messages.noConnections()]),
  )
  expect((await running.chad(["status"])).stdout).not.toContain("connection:")
})

test("a channel added with chad channel add takes an owner's message without a mention at once, a stranger's is still ignored there, other channels still need one, and chad channel remove makes it need one again", async () => {
  const running = await scenario({ env: { CHAD_LOG_LEVEL: "debug" } })
  const { fakes } = running
  await fakes.model.script([{ text: "one" }])
  const open = await fakes.chat.makeThread("channel")
  const other = await fakes.chat.makeThread("channel")
  const reasons = () =>
    running
      .log()
      .filter((line) => line.annotations["event"] === "message.ignored")
      .map((line) => line.annotations["reason"])

  expect(await running.chad(["channel", "add", "local", open.id])).toEqual(
    done([Messages.channelAdded(open.id, "local")]),
  )
  expect(await running.chad(["channel", "add", "local", open.id])).toEqual(
    done([Messages.channelListed(open.id, "local")]),
  )
  expect(await running.chad(["connection", "list"])).toEqual(
    done([Messages.connectionLine("local", "local", ["owner"], [open.id])]),
  )

  // The owner list still decides who is answered.
  expect(
    await fakes.chat.deliver(
      await fakes.chat.userPosts(open, { text: "hi", authorId: "stranger" }),
    ),
  ).toBe(true)
  await says(running, other, "hello")
  await lines(running, "message.ignored", 2)
  expect(reasons()).toEqual(["not-owner", "not-mentioned"])

  // The owner's message opens a thread on it, as a mention does.
  await says(running, open, "hello")
  await running.logged("turn.ended")
  const opened = (await Effect.runPromise(running.chat.calls)).filter(
    (call) => call.op === "startThread",
  )
  expect(opened.map((call) => call.thread)).toEqual([open])

  expect(await running.chad(["channel", "remove", "local", open.id])).toEqual(
    done([Messages.channelRemoved(open.id, "local")]),
  )
  expect(await running.chad(["channel", "remove", "local", open.id])).toEqual(
    done([Messages.channelUnlisted(open.id, "local")]),
  )
  await says(running, open, "again")
  await lines(running, "message.ignored", 3)
  expect(reasons()).toEqual(["not-owner", "not-mentioned", "not-mentioned"])
  expect(await posted(running, open)).toEqual([])
  expect(await fakes.model.calls()).toHaveLength(1)
})

test("an owner's /mention off makes only the channel it ran in need no mention, a stranger's message there is still ignored, a typed /mention on there makes it need one again, a thread with a session is said to need none, and a channel whose kind cannot be read is left off the list", async () => {
  const running = await scenario({ env: { CHAD_LOG_LEVEL: "debug" } })
  const { fakes } = running
  await fakes.model.script([{ text: "one" }, { text: "two" }])
  const open = await fakes.chat.makeThread("channel")
  const other = await fakes.chat.makeThread("channel")
  const reasons = () =>
    running
      .log()
      .filter((line) => line.annotations["event"] === "message.ignored")
      .map((line) => line.annotations["reason"])
  await running.logged("boot.ready")

  expect(
    await Effect.runPromise(running.command(open, "mention", "owner", "off")),
  ).toMatchObject({
    _tag: "Respond",
    markdown: Messages.commandTaken("mention"),
    visibility: "ephemeral",
  })
  const [off] = await fakes.chat.answers(open, 1)
  expect(off?.text).toBe(Messages.mentionChanged(false, true))
  expect(await running.chad(["connection", "list"])).toEqual(
    done([Messages.connectionLine("local", "local", ["owner"], [open.id])]),
  )

  // The owner list still decides who is answered, and the other channel still needs a mention.
  expect(
    await fakes.chat.deliver(
      await fakes.chat.userPosts(open, { text: "hi", authorId: "stranger" }),
    ),
  ).toBe(true)
  await says(running, other, "hello")
  await lines(running, "message.ignored", 2)
  expect(reasons()).toEqual(["not-owner", "not-mentioned"])

  await says(running, open, "hello")
  await running.logged("turn.ended")
  const opened = (await Effect.runPromise(running.chat.calls)).filter(
    (call) => call.op === "startThread",
  )
  expect(opened.map((call) => call.thread)).toEqual([open])

  // The channel needs no mention yet, so the typed command reaches chad without one.
  await says(running, open, "/mention on")
  const [, on] = await fakes.chat.answers(open, 2)
  expect(on?.text).toBe(Messages.mentionChanged(true, true))
  await says(running, open, "again")
  await lines(running, "message.ignored", 3)
  expect(reasons()).toEqual(["not-owner", "not-mentioned", "not-mentioned"])
  expect(await fakes.model.calls()).toHaveLength(1)

  // A thread with a session takes an owner's message without a mention whatever the list says, and /mention says so.
  const thread = await fakes.chat.makeThread("thread")
  await says(running, thread, "hi", { mention: true })
  await fakes.chat.answers(thread, 1)
  await Effect.runPromise(running.command(thread, "mention", "owner"))
  const [, state] = await fakes.chat.answers(thread, 2)
  expect(state?.text).toBe(Messages.mentionState("session"))
  await says(running, thread, "/mention on")
  const [, , kept] = await fakes.chat.answers(thread, 3)
  expect(kept?.text).toBe(Messages.mentionSessionKept(false))

  // A direct message whose kind the platform does not give never lands on the list.
  const direct = await fakes.chat.makeThread("direct")
  await Effect.runPromise(
    running.chat.failNext(
      "getThread",
      new ChatError.Forbidden({ detail: "down" }),
    ),
  )
  await Effect.runPromise(running.command(direct, "mention", "owner", "off"))
  const [unchecked] = await fakes.chat.answers(direct, 1)
  expect(unchecked?.text).toBe(Messages.mentionUnchecked)
  expect(await running.chad(["connection", "list"])).toEqual(
    done([Messages.connectionLine("local", "local", ["owner"])]),
  )
})

/** Calls the daemon of a scenario as a client of another process does, with the headers given. */
const makeClient = RpcClient.make(Rpcs)
const call = <A>(
  chad: Scenario,
  headers: Record<string, string>,
  use: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          NodeSocket.layerNet({ path: join(chad.data, "run/chad.sock") }),
        ),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    )
    const client = yield* makeClient.pipe(Effect.provideContext(protocol))
    return yield* use(client)
  }).pipe(
    RpcClient.withHeaders({ "chad-version": version, ...headers }),
    Effect.scoped,
    Effect.runPromise,
  )

test("changes that arrive at once go through the daemon's one queue, so none is lost, each leaves a command.ran line with its command, its caller and its outcome, and a call that carries a session id is made and names the session", async () => {
  const running = await scenario()
  await running.logged("boot.ready")
  const ids = Array.from({ length: 8 }, (_, index) => `friend-${index}`)

  const added = await Promise.all(
    ids.map((id) => running.chad(["owner", "add", "local", id])),
  )
  expect(added).toEqual(
    ids.map((id) => done([Messages.ownerAdded(id, "local")])),
  )
  // Each change was made on the list the one before it left, so the file and the daemon hold all eight.
  const owners: ReadonlyArray<string> = stored(running.data).connections[0]
    .owners
  expect([...owners].sort()).toEqual(["owner", ...ids].sort())
  expect(await running.chad(["connection", "list"])).toEqual(
    done([Messages.connectionLine("local", "local", owners)]),
  )
  const line = (command: string, caller: string, outcome: string) => ({
    command,
    caller,
    outcome,
    connection: "local",
  })
  expect(ran(running)).toEqual(
    ids.map(() => line("owner add", "owner", "changed")),
  )

  // The daemon does not refuse a call for its session id. It makes the change and names the session as the caller.
  const session = "0b4b1c9e-55d0-4d0c-9f0a-3e8f0f7f2a11"
  const change = { _tag: "OwnerAdd" as const, name: "local", id: "ada" }
  expect(
    await call(running, { "chad-session": session }, (client) =>
      client.ConnectionChange({ change }),
    ),
  ).toEqual({ changed: true })
  expect(
    await call(running, { "chad-session": "daemon" }, (client) =>
      client.ConnectionChange({ change }),
    ),
  ).toEqual({ changed: false })
  expect((await running.chad(["connection", "remove", "local"])).code).toBe(1)
  expect(ran(running).slice(ids.length)).toEqual([
    line("owner add", session, "changed"),
    line("owner add", "daemon", "unchanged"),
    {
      ...line("connection remove", "owner", "refused"),
      reason: "last-connection",
    },
  ])
  // A command that only reads leaves no line.
  expect((await running.chad(["connection", "list"])).code).toBe(0)
  expect(ran(running)).toHaveLength(ids.length + 3)
})
