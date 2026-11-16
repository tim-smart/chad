import { readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { Chat, ChatError } from "effect/chat"
import { describe, expect, it } from "vitest"
import { layers as localLayers } from "../../scripts/local.ts"
import * as Discord from "../../src/daemon/Discord.ts"
import config, { layers } from "../../vitest.config.ts"
import { path, read } from "../support/repo.ts"

describe("what chad asks of Discord", () => {
  it("the permissions in a server channel are the six that chad asks for", () => {
    const bit = (n: number) => BigInt(1) << BigInt(n)
    expect(Discord.permissions).toBe(
      // View Channel, Send Messages, Attach Files, Read Message History, Create Public Threads, Send Messages in Threads
      bit(10) | bit(11) | bit(15) | bit(16) | bit(35) | bit(38),
    )
    // Message content is the one intent chad asks for that Discord calls privileged.
    expect(Discord.privilegedIntents).toBe(1 << 15)
    expect(Discord.intents & Discord.privilegedIntents).toBe(1 << 15)
  })

  it("effect/chat has no operation that adds a reaction, and names no such capability", async () => {
    const chat = await Effect.runPromise(
      Chat.Chat.pipe(Effect.provide(Chat.layer)),
    )
    expect(Object.keys(chat)).toContain("post")
    expect(Object.keys(chat).filter((name) => /react/i.test(name))).toEqual([])
    expect(ChatError.Capability.literals).toContain("startThread")
    expect(
      ChatError.Capability.literals.filter((name) => /react/i.test(name)),
    ).toEqual([])
  })

  it("the shard state table has a fixed core name, and no migration of chad's creates it", () => {
    expect(Discord.shardTable).toBe("core_discord_shards")
    const migrations = "src/daemon/migrations"
    for (const name of readdirSync(path(migrations))) {
      expect(read(join(migrations, name))).not.toContain(Discord.shardTable)
    }
  })
})

describe("layer 6", () => {
  it("no project and no workflow reaches a real Discord or a Codex login, so none of layer 6 gates a pull request", () => {
    const projects = (config.test?.projects ?? []).map((project) =>
      typeof project === "object" && "test" in project
        ? project.test?.name
        : undefined,
    )
    expect(projects).toEqual(layers)
    expect(layers).toEqual(expect.arrayContaining(localLayers))
    // No workflow reads a secret of the repository's or names Discord or Codex.
    for (const name of readdirSync(path(".github/workflows"))) {
      expect(read(join(".github/workflows", name)), name).not.toMatch(
        /secrets\.(?!GITHUB_TOKEN\b)|discord|codex/i,
      )
    }
  })
})
