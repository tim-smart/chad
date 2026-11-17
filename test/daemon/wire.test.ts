// The Discord wire: the daemon with the product's Discord adapter, dfx's own shard and effect's dispatch hook,
// over a gateway socket the scenario scripts and a fake Discord REST server.
import { expect, test } from "vitest"
import type { Connection } from "../../dist/daemon/Connection.js"
import { execute } from "../support/database.ts"
import * as Discord from "../support/discord.ts"
import { type Scenario, scenario } from "../support/driver.ts"

const owner = "700000000000000001"

const dm = "800000000000000001"

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

test("in a server thread the answer replies to the owner's message with the reply ping on, pings nobody else, and lets Discord post it plain if that message is gone", async () => {
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

test("a save that fails refuses the event, and dfx resumes in the same process and replays it", async () => {
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

test("chad logs the gateway session coming up, each close with its code, and the close that is for good, after which that connection dials no more and the daemon carries on", async () => {
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
