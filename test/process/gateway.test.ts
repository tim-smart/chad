// The Discord wire slice in layer 4 (docs/spec/17-testing.md, TST-60b): the daemon in a child process, dfx's real
// shard over a WebSocket to the scripted gateway, and kills between its starts.
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import type { Connection } from "../../dist/daemon/Connection.js"
import * as Discord from "../support/discord.ts"
import { eventually } from "../support/owner.ts"
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

/** chad's answers in a channel, as Discord's REST got them. */
const answers = async (running: Process, count: number, channel = dm) =>
  (await running.discord.rest.answers(channel, count)).map(
    (call) => call.body?.["content"],
  )

test("SES-30b TST-60b TST-61d a dispatch that was in flight when the daemon was killed is not stored as seen, the next start resumes from the sequence before it, and Discord's replay is answered once", async () => {
  const running = await daemon({ connections: [home] })
  const { fakes } = running
  await fakes.model.script([{ text: "answered once" }])
  const first = await running.start()
  const socket = await identify(running, 0, "session-1")
  await running.logged("chat.connected")
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
}, 20_000)

test("SES-37 SES-170 SES-199 TST-61c TST-60b after a kill, a resume that Discord turns down ends in a fresh identify, and the catch-up reads forward from the last message chad saw in each active session and answers what the gateway never carried, once", async () => {
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

test("SES-172 SES-203 SES-204 SES-37 in a thread two bots share, a /new the gateway never carried is caught up by both connections and runs once, and a replay to both bots after a kill runs it no more", async () => {
  const away: Connection = { ...home, name: "away", token: "away-token" }
  // The drop of a duplicate is a debug line.
  const running = await daemon({
    connections: [home, away],
    env: { CHAD_LOG_LEVEL: "debug" },
  })
  const { fakes } = running
  const shared = "800000000000000003"
  running.discord.rest.channel(shared, 11)
  await fakes.model.script([{ text: "first answer" }])
  const first = await running.start()
  const socket = await identify(running, 0, "session-1")
  await identify(running, 1, "session-2")
  socket.receive(
    Discord.messageCreate(2, {
      id: "11",
      channel: shared,
      channelType: 11,
      guild: "600000000000000001",
      author: owner,
      content: `<@${Discord.bot}> hello`,
      mentions: [Discord.bot],
      timestamp: new Date().toISOString(),
    }),
  )
  expect(await answers(running, 1, shared)).toEqual(["first answer"])
  await first.kill()

  running.discord.rest.sent({
    id: "12",
    channel: shared,
    channelType: 11,
    guild: "600000000000000001",
    author: owner,
    content: "/new",
    timestamp: new Date().toISOString(),
  })
  const second = await running.start()
  // Each connection's resume is turned down, so each identifies afresh and runs its own catch-up.
  for (const index of [2, 3]) {
    const turnedDown = await running.discord.gateway.socket(index)
    turnedDown.receive(Discord.hello)
    await turnedDown.sent(Discord.Op.resume, 1)
    turnedDown.receive({ op: Discord.Op.invalidSession, d: false })
  }
  // Both catch-ups have read the old mark and reached the thread before either runs what it found, which is the race
  // of two bots.
  const releases = [home, away].map((connection) =>
    running.discord.rest.hold(
      connection.token!,
      new RegExp(`^/channels/${shared}/messages\\?`),
    ),
  )
  for (const [index, session] of [
    [4, "session-3"],
    [5, "session-4"],
  ] as const) {
    const socket = await running.discord.gateway.socket(index)
    socket.receive(Discord.hello)
    await socket.sent(Discord.Op.identify, 1)
    socket.receive(Discord.ready(1, session))
  }
  await running.discord.rest.called(
    "GET",
    new RegExp(`^/channels/${shared}/messages\\?`),
    2,
  )
  releases[0]!()
  await running.logged("command.ran")
  releases[1]!()
  // The other connection's catch-up has handled the /new once it ran it again or dropped it.
  const handled = await eventually(
    () => {
      const log = running.log()
      const since = log.findLastIndex(
        (line) => line.annotations["event"] === "boot.ready",
      )
      const after = log.slice(since)
      return {
        ran: after.filter((line) => line.annotations["event"] === "command.ran")
          .length,
        dropped: after.filter(
          (line) =>
            line.annotations["event"] === "message.ignored" &&
            line.annotations["reason"] === "duplicate" &&
            line.annotations["connection"] === "away",
        ).length,
      }
    },
    ({ ran, dropped }) => ran + dropped >= 2,
  )
  expect(handled).toEqual({ ran: 1, dropped: 1 })
  expect(await answers(running, 2, shared)).toEqual([
    "first answer",
    Messages.newSession(),
  ])
  // One reset leaves the ended session and the new one.
  expect(
    query(
      running.data,
      "SELECT ended_at IS NULL AS open FROM sessions ORDER BY created_at",
    ).map((row) => Number(row["open"])),
  ).toEqual([0, 1])
  const posts = running.discord.rest
    .calls()
    .filter(
      (call) =>
        call.method === "POST" &&
        call.path === `/channels/${shared}/messages` &&
        !Array.isArray(call.body?.["components"]),
    )
  expect(posts).toHaveLength(2)

  // After a kill, both bots resume and Discord replays the /new to each. The stored claim outlives the process.
  await second.kill()
  await running.start()
  for (const index of [6, 7]) {
    const again = await running.discord.gateway.socket(index)
    again.receive(Discord.hello)
    await again.sent(Discord.Op.resume, 1)
    again.receive(
      Discord.messageCreate(2, {
        id: "12",
        channel: shared,
        channelType: 11,
        guild: "600000000000000001",
        author: owner,
        content: "/new",
        timestamp: new Date().toISOString(),
      }),
    )
    again.receive(Discord.resumed(3))
  }
  const replayed = await eventually(
    () => {
      const log = running.log()
      const after = log.slice(
        log.findLastIndex((line) => line.annotations["event"] === "boot.ready"),
      )
      return {
        ran: after.filter((line) => line.annotations["event"] === "command.ran")
          .length,
        dropped: after.filter(
          (line) =>
            line.annotations["event"] === "message.ignored" &&
            line.annotations["reason"] === "duplicate",
        ).length,
      }
    },
    ({ ran, dropped }) => ran + dropped >= 2,
  )
  expect(replayed).toEqual({ ran: 0, dropped: 2 })
  expect(query(running.data, "SELECT id FROM sessions")).toHaveLength(2)
}, 30_000)
