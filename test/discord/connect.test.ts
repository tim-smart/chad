// Layer 6, the nightly Discord job: chad's test bot on the real gateway, driven by a second bot. It runs only from
// `node scripts/discord.ts`, which fails and names the secret when a token is missing.
import { Permissions } from "dfx/types"
import { expect, test } from "vitest"
import * as Discord from "../../dist/daemon/Discord.js"
import { scenario } from "../support/driver.ts"
import {
  bot,
  eventually,
  type Overwrite,
  permissionsIn,
} from "../support/live.ts"

const token = (name: string) => {
  const value = process.env[name] ?? ""
  if (value === "") throw new Error(`missing secrets: ${name}`)
  return value
}

/** The application flags Discord sets for a privileged intent, as granted and as granted to an unverified bot. */
const privileged = {
  presence: (1 << 12) | (1 << 13),
  guildMembers: (1 << 14) | (1 << 15),
  messageContent: (1 << 18) | (1 << 19),
}

test("TST-139 TST-143 TST-186a DIS-89 DIS-3 SES-8 chad's test bot holds exactly the listed intents and permissions, connects to the real gateway with them, and answers the second bot in a thread, with a mention and without one, on the fake model server", async () => {
  const chadBot = bot(token("DISCORD_CHAD_TOKEN"))
  const driver = bot(token("DISCORD_DRIVER_TOKEN"))
  const [chadUser, driverUser] = await Promise.all([
    chadBot.get("/users/@me"),
    driver.get("/users/@me"),
  ])

  // The scratch server is the one server both bots are in, and the scenario uses its first text channel.
  type Guilds = ReadonlyArray<{ id: string }>
  const chadGuilds: Guilds = await chadBot.get("/users/@me/guilds")
  const driverGuilds: Guilds = await driver.get("/users/@me/guilds")
  const shared = chadGuilds.filter((guild) =>
    driverGuilds.some((other) => other.id === guild.id),
  )
  expect(shared, "the two bots share exactly one server").toHaveLength(1)
  const guild = shared[0]!.id
  const channels: ReadonlyArray<{
    id: string
    type: number
    position: number
    permission_overwrites?: ReadonlyArray<Overwrite>
  }> = await driver.get(`/guilds/${guild}/channels`)
  const channel = channels
    .filter((channel) => channel.type === 0)
    .sort((a, b) => a.position - b.position)[0]
  if (channel === undefined)
    throw new Error("the scratch server has no text channel")

  // The bot has the privileged intents of chad's list and no other, and in the channel exactly chad's permissions.
  const application: { flags: number } = await chadBot.get("/applications/@me")
  expect({
    messageContent: (application.flags & privileged.messageContent) !== 0,
    presence: (application.flags & privileged.presence) !== 0,
    guildMembers: (application.flags & privileged.guildMembers) !== 0,
  }).toEqual({ messageContent: true, presence: false, guildMembers: false })
  const held = await permissionsIn(driver, guild, channel, chadUser.id)
  const names = (bits: bigint) =>
    Object.entries(Permissions)
      .filter(([, bit]) => (bits & bit) !== BigInt(0))
      .map(([name]) => name)
      .sort()
  expect(names(held)).toEqual(names(Discord.permissions))

  const chad = await scenario({
    live: true,
    connections: [
      {
        name: "scratch",
        kind: "discord",
        token: token("DISCORD_CHAD_TOKEN"),
        owners: [driverUser.id],
      },
    ],
  })
  await chad.fakes.model.script([
    { text: "an answer from the nightly job" },
    { text: "a second answer" },
  ])
  // Discord closes the gateway for good on an intent the bot may not use, which is the line chat.refused.
  const line = await Promise.race([
    chad.logged("chat.connected"),
    chad.logged("chat.refused"),
  ])
  expect(line.annotations).toMatchObject({
    event: "chat.connected",
    resumed: false,
  })

  // Until a mention in a channel opens a thread, the second bot opens the thread itself and mentions chad in it.
  const thread: { id: string } = await driver.post(
    `/channels/${channel.id}/threads`,
    { name: `nightly ${new Date().toISOString()}`, type: 11 },
  )
  try {
    await driver.post(`/channels/${thread.id}/messages`, {
      content: `<@${chadUser.id}> hello from the nightly job`,
    })
    // chad's bot reads its own answers, because Discord shows a bot the content of its own messages whatever its
    // intents, and the second bot's intents are not part of the set-up.
    const answered = (count: number) =>
      eventually(async () => {
        const messages: ReadonlyArray<{
          author: { id: string }
          content: string
        }> = await chadBot.get(`/channels/${thread.id}/messages?limit=20`)
        const own = messages
          .filter((message) => message.author.id === chadUser.id)
          .map((message) => message.content)
          .reverse()
        return own.length >= count ? own : undefined
      })
    expect(await answered(1)).toEqual(["an answer from the nightly job"])

    // With the message content intent, chad reads a message in the thread that does not mention it.
    await driver.post(`/channels/${thread.id}/messages`, {
      content: "and one without a mention",
    })
    expect(await answered(2)).toEqual([
      "an answer from the nightly job",
      "a second answer",
    ])
    const calls = await chad.fakes.model.calls()
    expect(JSON.stringify(calls[0]?.body)).toContain(
      "hello from the nightly job",
    )
    expect(JSON.stringify(calls[1]?.body)).toContain(
      "and one without a mention",
    )
  } finally {
    // The second bot holds Manage Threads, so that no run leaves a thread behind.
    await driver.delete(`/channels/${thread.id}`)
  }
})
