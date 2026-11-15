// The Discord wire slice: the daemon with the product's Discord adapter, dfx's own shard and effect's dispatch hook,
// over a gateway socket the scenario scripts and a fake Discord REST server.
import { Effect, Layer } from "effect"
import { Chat } from "effect/chat"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { Connection } from "../../dist/daemon/Connection.js"
import * as DiscordLayer from "../../dist/daemon/Discord.js"
import * as Messages from "../../dist/Messages.js"
import { execute, query } from "../support/database.ts"
import * as Discord from "../support/discord.ts"
import { httpClient, type Scenario, scenario } from "../support/driver.ts"

const owner = "700000000000000001"
const stranger = "700000000000000002"
const dm = "800000000000000001"
const otherDm = "800000000000000002"
const home: Connection = {
  name: "home",
  kind: "discord",
  token: "home-token",
  owners: [owner],
}

/** Plays Discord's side of a fresh identify on the daemon's socket number `index`. */
const identify = async (chad: Scenario, index = 0, session = "session-1") => {
  const socket = await chad.discord.gateway.socket(index)
  socket.receive(Discord.hello)
  const [identified] = await socket.sent(Discord.Op.identify, 1)
  socket.receive(Discord.ready(1, session))
  return { socket, identified }
}

/** Plays Discord's side of a fresh identify for each of `count` connections, and tells the sockets apart by the token. */
const identifyAll = async (chad: Scenario, count: number) => {
  const sockets = new Map<string, Discord.GatewaySocket>()
  await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const socket = await chad.discord.gateway.socket(index)
      socket.receive(Discord.hello)
      const [identified] = await socket.sent(Discord.Op.identify, 1)
      const name = String(identified?.token).replace("-token", "")
      socket.receive(Discord.ready(1, `session-${name}`))
      sockets.set(name, socket)
    }),
  )
  return sockets
}

/** An owner's DM with sequence `s`. */
const direct = (s: number, id: string, content: string, author = owner) =>
  Discord.messageCreate(s, { id, channel: dm, author, content })

/** Waits for chad's answers in a channel, as Discord's REST got them. */
const answers = async (chad: Scenario, count: number, channel = dm) =>
  (await chad.discord.rest.answers(channel, count)).map((call) => call.body)

const shards = (chad: Scenario) =>
  query(
    chad.data,
    "SELECT id, CAST(value AS TEXT) AS value FROM core_discord_shards ORDER BY id",
  ).map((row) => [row["id"], JSON.parse(String(row["value"]))])

test("TST-60a OV-45 DIS-1 DIS-8 DIS-15 DIS-86 a DM over the scripted gateway runs a turn, and the answer goes out through Discord's REST", async () => {
  const chad = await scenario({ connections: [home] })
  await chad.fakes.model.script([{ text: "scripted answer" }])
  const { socket, identified } = await identify(chad)
  // chad dials out, and identifies with the intents for guilds, guild messages, direct messages and message content.
  expect(socket.url).toBe(Discord.gatewayUrl + "?v=10&encoding=json")
  expect(identified).toMatchObject({
    token: "home-token",
    shard: [0, 1],
    intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15),
  })
  socket.receive(direct(2, "1", "hello"))

  const [answer] = await answers(chad, 1)
  // The write pings nobody and shows no link embed, which is flag 4.
  expect(answer).toEqual({
    content: "scripted answer",
    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    flags: 4,
  })
  const [call] = await chad.fakes.model.calls()
  expect(JSON.stringify(call?.body)).toContain("hello")
  // Nothing went to Discord's typing endpoint, and every request went to Discord's REST root or to the model.
  const calls = chad.discord.rest.calls().map((call) => call.path)
  expect(calls.filter((path) => path.endsWith("/typing"))).toEqual([])
  expect(
    chad
      .requests()
      .filter(
        (url) =>
          !url.startsWith(Discord.restRoot) &&
          !url.startsWith("http://127.0.0.1:"),
      ),
  ).toEqual([])
})

test("DIS-55 DIS-52 DIS-100 in a server thread the answer replies to the owner's message with the reply ping on, pings nobody else, and lets Discord post it plain if that message is gone", async () => {
  const thread = "810000000000000002"
  const chad = await scenario({ connections: [home] })
  chad.discord.rest.channel(thread, 11)
  await chad.fakes.model.script([{ text: "in the thread" }])
  const { socket } = await identify(chad)
  socket.receive(
    Discord.messageCreate(2, {
      id: "3",
      channel: thread,
      channelType: 11,
      guild: "600000000000000001",
      author: owner,
      content: `<@${Discord.bot}> hello`,
      mentions: [Discord.bot],
    }),
  )
  expect(await answers(chad, 1, thread)).toEqual([
    {
      content: "in the thread",
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: true },
      flags: 4,
      message_reference: { message_id: "3", fail_if_not_exists: false },
    },
  ])
})

test("STO-35 STO-147 STO-148 SES-30a SES-185 TST-61b each connection answers with its own token and keeps its shard state in a row of core_discord_shards under its name, and a restart on the volume resumes with it", async () => {
  const work: Connection = { ...home, name: "work", token: "work-token" }
  const first = await scenario({ connections: [home, work] })
  await first.fakes.model.script([{ text: "one" }, { text: "two" }])
  // The two connections dial in either order.
  const sockets = await identifyAll(first, 2)
  expect([...sockets.keys()].sort()).toEqual(["home", "work"])
  // Each connection's owner writes in a DM channel of that connection's bot, and each answer goes out with the
  // token of the connection the message arrived on.
  for (const name of ["home", "work"]) {
    const channel = name === "home" ? dm : otherDm
    sockets.get(name)?.receive(
      Discord.messageCreate(2, {
        id: channel,
        channel,
        author: owner,
        content: `from ${name}`,
      }),
    )
    const [answer] = await first.discord.rest.answers(channel, 1)
    expect(answer?.headers["authorization"]).toBe(`Bot ${name}-token`)
  }
  expect(await first.stop()).toBe(0)
  const state = (name: string) => ({
    sessionId: `session-${name}`,
    resumeUrl: Discord.resumeUrl,
    sequence: 2,
  })
  expect(shards(first)).toEqual([
    ["home/dfx-shard-state-0-1", state("home")],
    ["work/dfx-shard-state-0-1", state("work")],
  ])

  const second = await scenario({
    directory: first.directory,
    connections: [home, work],
  })
  const resumes = await Promise.all(
    [0, 1].map(async (index) => {
      const socket = await second.discord.gateway.socket(index)
      socket.receive(Discord.hello)
      const [resume] = await socket.sent(Discord.Op.resume, 1)
      socket.receive(Discord.resumed(3))
      // A resume is not an identify.
      expect(socket.opcodes()).not.toContain(Discord.Op.identify)
      return resume
    }),
  )
  expect(
    resumes.sort((a, b) => String(a?.token).localeCompare(String(b?.token))),
  ).toEqual([
    { token: "home-token", session_id: "session-home", seq: 2 },
    { token: "work-token", session_id: "session-work", seq: 2 },
  ])
  // The log holds the first daemon's lines too, so the line asked for is the one of a resume.
  for (const name of ["home", "work"]) {
    await second.logged(
      "chat.connected",
      (line) =>
        line.annotations["connection"] === name &&
        line.annotations["resumed"] === true,
    )
  }
})

test("OV-39 SES-30a SES-32 SES-128 TST-61d a save that fails refuses the event, and dfx resumes in the same process and replays it", async () => {
  const chad = await scenario({ connections: [home] })
  await chad.fakes.model.script([{ text: "after the replay" }])
  const { socket } = await identify(chad)
  await chad.logged("chat.connected")
  execute(
    chad.data,
    "CREATE TRIGGER full BEFORE INSERT ON cluster_messages BEGIN SELECT RAISE(ABORT, 'the save fails'); END",
  )
  socket.receive(direct(2, "1", "hello"))

  // dfx drops the socket it could not handle a dispatch on, with its own close code.
  expect(await socket.ended()).toEqual({ code: 3000, by: "chad" })
  const again = await chad.discord.gateway.socket(1)
  expect(again.url).toBe(Discord.resumeUrl + "?v=10&encoding=json")
  again.receive(Discord.hello)
  // The resume comes after dfx's own wait of a second, from the sequence before the refused event.
  const [resume] = await again.sent(Discord.Op.resume, 1)
  expect(resume).toEqual({
    token: "home-token",
    session_id: "session-1",
    seq: 1,
  })
  expect(await chad.fakes.model.calls()).toEqual([])

  execute(chad.data, "DROP TRIGGER full")
  again.receive(direct(2, "1", "hello"))
  again.receive(Discord.resumed(3))
  expect(await answers(chad, 1)).toMatchObject([
    { content: "after the replay" },
  ])
  expect(await chad.fakes.model.calls()).toHaveLength(1)
})

test("OV-39 TST-61d an event that Discord sends a second time starts no second turn", async () => {
  const chad = await scenario({ connections: [home] })
  await chad.fakes.model.script([{ text: "first" }, { text: "second" }])
  const { socket } = await identify(chad)
  socket.receive(direct(2, "1", "hello"))
  await answers(chad, 1)
  socket.receive(direct(3, "1", "hello"))
  socket.receive(direct(4, "2", "and again"))
  await answers(chad, 2)

  expect(await chad.fakes.model.calls()).toHaveLength(2)
  await chad.stop()
  expect(
    query(chad.data, "SELECT message_id FROM cluster_messages"),
  ).toHaveLength(2)
})

test("TST-61a Discord's side marks chad's own message, a bot, a webhook and a mention, and the request carries the marks", async () => {
  const webhook = "700000000000000009"
  const thread = "810000000000000001"
  // The drop of chad's own message is a debug line.
  const chad = await scenario({
    connections: [{ ...home, owners: [webhook, Discord.bot] }],
    env: { CHAD_LOG_LEVEL: "debug" },
  })
  await chad.fakes.model.script([{ text: "to the webhook" }])
  const { socket } = await identify(chad)
  // chad's own id is on the owner list, and its message is still dropped as its own.
  socket.receive(direct(2, "1", "my own answer", Discord.bot))
  const own = await chad.logged("message.ignored")
  expect(own.annotations).toMatchObject({ reason: "own", author: Discord.bot })

  // A webhook's message has the webhook's id as its author, and it is a bot's message and not chad's own.
  socket.receive(
    Discord.messageCreate(3, {
      id: "2",
      channel: thread,
      channelType: 11,
      guild: "600000000000000001",
      author: webhook,
      webhook: true,
      content: `<@${Discord.bot}> are you there`,
      mentions: [Discord.bot],
    }),
  )
  expect(await answers(chad, 1, thread)).toMatchObject([
    { content: "to the webhook" },
  ])
  await chad.stop()
  const [request] = query(chad.data, "SELECT payload FROM cluster_messages")
  const { message } = JSON.parse(String(request?.["payload"]))
  expect(message.author).toMatchObject({
    id: webhook,
    isBot: true,
    isSelf: false,
  })
  expect(message.mentions).toMatchObject([
    { kind: "user", id: Discord.bot, isSelf: true },
  ])
})

test("TST-66 DIS-10 a DM from someone who is not an owner starts no turn over the gateway, and neither does an edit or a deletion", async () => {
  const chad = await scenario({ connections: [home] })
  await chad.fakes.model.script([{ text: "to the owner" }, { text: "again" }])
  const { socket } = await identify(chad)
  socket.receive(direct(2, "1", "let me in", stranger))
  const ignored = await chad.logged("message.ignored")
  expect(ignored.annotations).toMatchObject({
    reason: "not-owner",
    author: stranger,
    connection: "home",
  })
  expect(JSON.stringify(ignored)).not.toContain("let me in")

  socket.receive(direct(3, "2", "hello"))
  await answers(chad, 1)
  // Discord tells of an edit and of a deletion, and effect/chat hands chad neither.
  socket.receive({
    ...direct(4, "2", "something else"),
    t: "MESSAGE_UPDATE",
  })
  socket.receive({
    op: Discord.Op.dispatch,
    t: "MESSAGE_DELETE",
    s: 5,
    d: { id: "2", channel_id: dm },
  })
  socket.receive(direct(6, "3", "and again"))
  await answers(chad, 2)

  const calls = await chad.fakes.model.calls()
  expect(calls).toHaveLength(2)
  expect(JSON.stringify(calls)).not.toContain("let me in")
  expect(JSON.stringify(calls)).not.toContain("something else")
  await chad.stop()
  expect(
    query(chad.data, "SELECT message_id FROM cluster_messages"),
  ).toHaveLength(2)
})

test("SES-38 a resume that Discord turns down ends in a fresh identify, and chat.connected tells the two apart", async () => {
  const first = await scenario({ connections: [home] })
  await first.fakes.model.script([{ text: "one" }])
  const { socket } = await identify(first)
  const fresh = await first.logged("chat.connected")
  expect(fresh.annotations).toMatchObject({
    connection: "home",
    resumed: false,
  })
  socket.receive(direct(2, "1", "hello"))
  await answers(first, 1)
  await first.stop()

  const second = await scenario({
    directory: first.directory,
    connections: [home],
  })
  const stale = await second.discord.gateway.socket(0)
  stale.receive(Discord.hello)
  await stale.sent(Discord.Op.resume, 1)
  // Discord answers a session it no longer holds with an invalid session that cannot be resumed.
  stale.receive({ op: Discord.Op.invalidSession, d: false })
  const { identified } = await identify(second, 1, "session-2")
  expect(identified).toMatchObject({ token: "home-token" })
  second.discord.gateway.sockets()[1]?.receive(direct(2, "9", "still here"))
  await second.fakes.model.script([{ text: "two" }])
  await answers(second, 1)
  await second.stop()
  expect(shards(second)).toEqual([
    [
      "home/dfx-shard-state-0-1",
      { sessionId: "session-2", resumeUrl: Discord.resumeUrl, sequence: 2 },
    ],
  ])
})

test("TST-198 CLI-206 a bot that is removed and another that is added under the same name while no daemon runs starts with the old bot's stored resume state, Discord turns the resume down, and dfx identifies again", async () => {
  const first = await scenario({ connections: [home] })
  await first.fakes.model.script([{ text: "one" }])
  const { socket } = await identify(first)
  socket.receive(direct(2, "1", "hello"))
  await answers(first, 1)
  expect(await first.stop()).toBe(0)
  const old = [
    "home/dfx-shard-state-0-1",
    { sessionId: "session-1", resumeUrl: Discord.resumeUrl, sequence: 2 },
  ]
  expect(shards(first)).toEqual([old])

  // With no daemon the removal needs no database, so the old bot's row stays where it is.
  expect(await first.chad(["connection", "remove", "home", "--force"])).toEqual(
    { stdout: Messages.connectionRemoved("home") + "\n", stderr: "", code: 0 },
  )
  expect(shards(first)).toEqual([old])
  const file = join(first.directory, "token")
  writeFileSync(file, "other-token\n")
  const added = await first.cli([
    "connection",
    "add",
    "discord",
    "--name",
    "home",
    "--token-file",
    file,
  ])
  expect(added.code).toBe(0)
  expect((await first.chad(["owner", "add", "home", owner])).code).toBe(0)

  const second = await scenario({ directory: first.directory })
  const stale = await second.discord.gateway.socket(0)
  stale.receive(Discord.hello)
  // The new bot resumes the old bot's session, which is not its own.
  const [resume] = await stale.sent(Discord.Op.resume, 1)
  expect(resume).toEqual({
    token: "other-token",
    session_id: "session-1",
    seq: 2,
  })
  stale.receive({ op: Discord.Op.invalidSession, d: false })
  const { identified } = await identify(second, 1, "session-2")
  expect(identified).toMatchObject({ token: "other-token" })
})

test("CLI-190 CLI-207 STO-149 STO-198 the running daemon deletes a removed connection's shard state at once and leaves the rows of a connection whose name only begins with the same letters, a removal made with no daemon leaves the rows, and the next boot deletes those of every connection that is no longer stored", async () => {
  // The second name begins with the first, so only the separator tells their rows apart.
  const home2: Connection = { ...home, name: "home2", token: "home2-token" }
  const first = await scenario({ connections: [home, home2] })
  await first.fakes.model.script([{ text: "one" }, { text: "two" }])
  const sockets = await identifyAll(first, 2)
  for (const name of ["home", "home2"]) {
    const channel = name === "home" ? dm : otherDm
    sockets.get(name)?.receive(
      Discord.messageCreate(2, {
        id: channel,
        channel,
        author: owner,
        content: `from ${name}`,
      }),
    )
    await answers(first, 1, channel)
  }
  expect(await first.stop()).toBe(0)
  const keys = (chad: Scenario) => shards(chad).map(([key]) => key)
  expect(keys(first)).toEqual([
    "home/dfx-shard-state-0-1",
    "home2/dfx-shard-state-0-1",
  ])

  // The second daemon resumes both, so both rows were there when the command came.
  const second = await scenario({ directory: first.directory })
  const resumed = new Map<string, Discord.GatewaySocket>()
  await Promise.all(
    [0, 1].map(async (index) => {
      const socket = await second.discord.gateway.socket(index)
      socket.receive(Discord.hello)
      const [resume] = await socket.sent(Discord.Op.resume, 1)
      socket.receive(Discord.resumed(3))
      resumed.set(String(resume?.["token"]).replace("-token", ""), socket)
    }),
  )
  expect(await second.chad(["connection", "remove", "home"])).toEqual({
    stdout: Messages.connectionRemoved("home") + "\n",
    stderr: "",
    code: 0,
  })
  expect(keys(second)).toEqual(["home2/dfx-shard-state-0-1"])
  expect((await resumed.get("home")!.ended()).by).toBe("chad")
  expect(resumed.get("home2")?.closed).toBeUndefined()
  expect(await second.stop()).toBe(0)

  // With no daemon the row of the removed connection stays, and the boot that follows deletes it.
  expect(
    (await second.chad(["connection", "remove", "home2", "--force"])).code,
  ).toBe(0)
  expect(keys(second)).toEqual(["home2/dfx-shard-state-0-1"])
  const third = await scenario({ directory: first.directory })
  await third.logged(
    "boot.ready",
    (line) => line.annotations["connections"] === 0,
  )
  expect(keys(third)).toEqual([])
})

test("DIS-110 DIS-115 FAIL-298 FAIL-299 FAIL-300 FAIL-323 TST-196 chad logs the gateway session coming up, each close with its code, and the close that is for good, after which that connection dials no more and the daemon carries on", async () => {
  const work: Connection = { ...home, name: "work", token: "work-token" }
  const chad = await scenario({
    connections: [
      home,
      work,
      { name: "local", kind: "local", owners: ["owner"] },
    ],
  })
  const sockets = await identifyAll(chad, 2)
  const up = await chad.logged(
    "chat.connected",
    (line) => line.annotations["connection"] === "home",
  )
  expect(up.annotations).toMatchObject({ resumed: false })
  expect(up.level).toBe("INFO")

  // A close that Discord may follow with a new session: dfx dials again and resumes.
  sockets.get("work")?.drop(1001)
  const closed = await chad.logged("chat.disconnected")
  expect(closed.annotations).toMatchObject({
    connection: "work",
    code: 1001,
    by: "discord",
  })
  expect(closed.level).toBe("WARN")
  const again = await chad.discord.gateway.socket(2)
  again.receive(Discord.hello)
  expect(await again.sent(Discord.Op.resume, 1)).toMatchObject([
    { token: "work-token" },
  ])

  // Discord closes with 4014 for an intent the bot may not use, and takes no new session from it. The other
  // connection's socket closes right after with a code that is not for good. dfx's wait before it dials doubles with
  // each close of a connection, so a dial for the refused connection would come first.
  sockets.get("home")?.drop(4014)
  again.drop(1001)
  const refused = await chad.logged("chat.refused")
  expect(refused.annotations).toMatchObject({ connection: "home", code: 4014 })
  expect(refused.level).toBe("ERROR")
  const last = await chad.logged(
    "chat.disconnected",
    (line) => line.annotations["code"] === 4014,
  )
  expect(last.annotations).toMatchObject({ connection: "home", by: "discord" })
  const next = await chad.discord.gateway.socket(3)
  next.receive(Discord.hello)
  expect(await next.sent(Discord.Op.resume, 1)).toMatchObject([
    { token: "work-token" },
  ])

  // The daemon stays up without that connection.
  await chad.fakes.model.script([{ text: "still up" }])
  const thread = await chad.fakes.chat.makeThread("direct")
  const event = await chad.fakes.chat.userPosts(thread, {
    text: "hello",
    authorId: "owner",
  })
  expect(await chad.fakes.chat.deliver(event)).toBe(true)
  await chad.fakes.chat.answers(thread, 1)
  expect(chad.discord.gateway.sockets()).toHaveLength(4)
  expect(await chad.stop()).toBe(0)
  expect(chad.log().some((line) => line.level === "FATAL")).toBe(false)
  // A close that chad's side starts says so: the stop closes the one gateway that is left.
  const stopped = chad
    .log()
    .filter((line) => line.annotations["by"] === "chad")
    .map((line) => line.annotations["connection"])
  expect(stopped).toEqual(["work"])
})

test("SES-4a TST-61e startThread is get-or-create on Discord's REST: the second call for one message gives the thread of the first", async () => {
  const rest = await Discord.rest()
  try {
    const channel = "820000000000000001"
    rest.channel(channel, 0)
    const threads = await Effect.gen(function* () {
      const chat = yield* Chat.Chat
      const start = chat.startThread(
        DiscordLayer.DiscordChat.thread(channel),
        "830000000000000001",
        { name: "a thread" },
      )
      return [yield* start, yield* start]
    }).pipe(
      Effect.provide(
        DiscordLayer.adapter(home).pipe(
          Layer.provideMerge(Chat.layer),
          Layer.provide(httpClient({ model: rest.url, discord: rest.url })),
        ),
      ),
      Effect.runPromise,
    )
    // Discord refused the second create with its code 160004, and the adapter gave the thread under the message.
    expect(
      rest
        .calls()
        .filter((call) => call.path.endsWith("/threads"))
        .map((call) => call.path),
    ).toEqual([
      `/channels/${channel}/messages/830000000000000001/threads`,
      `/channels/${channel}/messages/830000000000000001/threads`,
    ])
    expect(threads[1]).toEqual(threads[0])
    expect(threads[0]).toEqual(
      DiscordLayer.DiscordChat.thread("830000000000000001"),
    )
  } finally {
    await rest.close()
  }
})
