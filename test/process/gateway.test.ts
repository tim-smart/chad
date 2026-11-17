// The Discord gateway in layer 4: the daemon in a child process, dfx's real shard over a WebSocket to the scripted
// gateway, and kills between its starts.
import { expect, test } from "vitest"
import type { Connection } from "../../dist/daemon/Connection.js"
import * as Discord from "../support/discord.ts"
import { daemon, type Process } from "../support/process.ts"
import { execute, query } from "../support/database.ts"

const owner = "700000000000000001"
const dm = "800000000000000001"
const other = "800000000000000002"
const home: Connection = {
  name: "home",
  kind: "discord",
  token: "home-token",
  owners: [owner],
}

/** An owner's DM with sequence `s`, sent now, so that its session counts as active for the catch-up. */
const direct = (s: number, id: string, content: string, channel = dm) =>
  Discord.messageCreate(s, {
    id,
    channel,
    author: owner,
    content,
    timestamp: new Date().toISOString(),
  })

/** Plays Discord's side of a fresh identify on the daemon's socket number `index`. */
const identify = async (running: Process, index: number, session: string) => {
  const socket = await running.discord.gateway.socket(index)
  socket.receive(Discord.hello)
  await socket.sent(Discord.Op.identify, 1)
  socket.receive(Discord.ready(1, session))
  return socket
}

/** The path of the call that sets the bot's slash commands. */
const commands = new RegExp(`^/applications/${Discord.application}/commands$`)

/** chad's answers in a channel, as Discord's REST got them. */
const answers = async (running: Process, count: number, channel = dm) =>
  (await running.discord.rest.answers(channel, count)).map(
    (call) => call.body?.["content"],
  )

test("a dispatch that was in flight when the daemon was killed is not stored as seen, the next start resumes from the sequence before it, Discord's replay is answered once, and each start sets the slash commands", async () => {
  const running = await daemon({ connections: [home] })
  const { fakes } = running
  await fakes.model.script([{ text: "answered once" }])
  const first = await running.start()
  const socket = await identify(running, 0, "session-1")
  await running.logged("chat.connected")
  await running.discord.rest.called("PUT", commands, 1)
  // The daemon is stopped dead, so the dispatch reaches its socket and is never handled.
  first.signal("SIGSTOP")
  socket.receive(direct(2, "11", "hello"))
  await first.kill()

  await running.start()
  const again = await running.discord.gateway.socket(1)
  again.receive(Discord.hello)
  const [resume] = await again.sent(Discord.Op.resume, 1)
  expect(resume).toMatchObject({ session_id: "session-1", seq: 1 })
  again.receive(direct(2, "11", "hello"))
  again.receive(Discord.resumed(3))
  expect(await answers(running, 1)).toEqual(["answered once"])
  expect(await fakes.model.calls()).toHaveLength(1)
  // The second start resumed and got no READY, and it set the commands all the same.
  expect(await running.discord.rest.called("PUT", commands, 2)).toHaveLength(2)
}, 20_000)

test("after a kill, a resume that Discord turns down ends in a fresh identify, and the catch-up reads forward from the last message chad saw in each active session and answers what the gateway never carried, once", async () => {
  const running = await daemon({ connections: [home] })
  const { fakes } = running
  await fakes.model.script([
    { text: "first answer" },
    { text: "old answer" },
    { text: "caught up" },
  ])
  const first = await running.start()
  const socket = await identify(running, 0, "session-1")
  socket.receive(direct(2, "11", "first"))
  expect(await answers(running, 1)).toEqual(["first answer"])
  socket.receive(direct(3, "21", "old", other))
  expect(await answers(running, 1, other)).toEqual(["old answer"])
  await first.kill()

  // While no daemon runs: a message in each DM, and the second DM's last message is older than the 7 days, scaled.
  running.discord.rest.sent({
    id: "12",
    channel: dm,
    author: owner,
    content: "while away",
    timestamp: new Date().toISOString(),
  })
  running.discord.rest.sent({
    id: "22",
    channel: other,
    author: owner,
    content: "too late",
  })
  const stale = Date.now() - 8 * 24 * 60 * 60 * 1000
  execute(
    running.data,
    `UPDATE sessions SET last_message_at = ${stale} WHERE thread LIKE '%${other}%'`,
  )
  expect(
    query(running.data, "SELECT last_message_id FROM sessions ORDER BY thread"),
  ).toEqual([{ last_message_id: "11" }, { last_message_id: "21" }])

  await running.start()
  const turnedDown = await running.discord.gateway.socket(1)
  turnedDown.receive(Discord.hello)
  await turnedDown.sent(Discord.Op.resume, 1)
  turnedDown.receive({ op: Discord.Op.invalidSession, d: false })
  await identify(running, 2, "session-2")
  expect(await answers(running, 2)).toEqual(["first answer", "caught up"])
  const calls = await fakes.model.calls()
  expect(calls).toHaveLength(3)
  expect(JSON.stringify(calls[2]!.body)).toContain("while away")
  const read = running.discord.rest
    .calls()
    .filter(
      (call) =>
        call.method === "GET" &&
        call.path.startsWith(`/channels/${dm}/messages?`),
    )
  expect(new URL(read[0]!.path, "http://rest").searchParams.get("after")).toBe(
    "11",
  )
  expect(
    running.discord.rest
      .calls()
      .some(
        (call) =>
          call.method === "GET" &&
          call.path.startsWith(`/channels/${other}/messages?`),
      ),
  ).toBe(false)
}, 20_000)
