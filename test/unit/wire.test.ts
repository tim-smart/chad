import { readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { Chat, ChatError } from "effect/chat"
import { describe, expect, it } from "vitest"
import { secrets } from "../../scripts/discord.ts"
import { layers as localLayers } from "../../scripts/local.ts"
import { gateProjects } from "../../scripts/rule-ids.ts"
import * as Discord from "../../src/daemon/Discord.ts"
import config, { layers, live } from "../../vitest.config.ts"
import { exists, path, read, yaml } from "../support/repo.ts"

describe("what chad asks of Discord", () => {
  it("DIS-4 DIS-87 the permissions in a server channel are the six of the list, Create Public Threads among them", () => {
    const bit = (n: number) => BigInt(1) << BigInt(n)
    expect(Discord.permissions).toBe(
      // View Channel, Send Messages, Attach Files, Read Message History, Create Public Threads, Send Messages in Threads
      bit(10) | bit(11) | bit(15) | bit(16) | bit(35) | bit(38),
    )
    expect(Discord.permissions & bit(35)).toBe(bit(35))
    // Message content is the one intent of the list that Discord calls privileged.
    expect(Discord.privilegedIntents).toBe(1 << 15)
    expect(Discord.intents & Discord.privilegedIntents).toBe(1 << 15)
  })

  it("DIS-9 effect/chat has no operation that adds a reaction, and names no such capability", async () => {
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

  it("STO-147 the shard state table has a fixed core name, and no migration of chad's creates it", () => {
    expect(Discord.shardTable).toBe("core_discord_shards")
    const migrations = "src/daemon/migrations"
    for (const name of readdirSync(path(migrations))) {
      expect(read(join(migrations, name))).not.toContain(Discord.shardTable)
    }
  })
})

describe("the nightly Discord job", () => {
  const file = ".github/workflows/nightly-discord.yml"
  const nightly = yaml(file)
  interface Step {
    readonly run?: string
    readonly if?: string
    readonly env?: Readonly<Record<string, string>>
  }
  const steps: ReadonlyArray<Step> = nightly.jobs.discord.steps
  const workflows = readdirSync(path(".github/workflows")).map(
    (name) => `.github/workflows/${name}`,
  )

  it("TST-30 layer 6 is a project of its own that no pull request runs", () => {
    expect(live).toEqual(["discord"])
    expect(layers).not.toContain("discord")
    expect(localLayers).not.toContain("discord")
    expect(gateProjects).not.toContain("discord")
    expect(
      (config.test?.projects ?? []).map((project) =>
        typeof project === "object" && "test" in project
          ? project.test?.name
          : undefined,
      ),
    ).toEqual([...layers, "discord"])
    expect(read(".github/workflows/gate.yml")).not.toMatch(/discord/i)
    expect(nightly.on.pull_request).toBeUndefined()
  })

  it("TST-139 TST-143 TST-206 the job runs every night on the two bot tokens of the repository's secrets, and no other workflow reads them", () => {
    expect(nightly.on.schedule).toEqual([{ cron: "0 14 * * *" }])
    // Until the build's pull request is merged, a push of the trigger file runs the job from the shared branch.
    expect(nightly.on.push).toEqual({
      branches: ["chad-v1"],
      paths: [".github/triggers/nightly-discord"],
    })
    expect(exists(".github/triggers/nightly-discord")).toBe(true)
    const run = steps.find((step) => step.run === "node scripts/discord.ts")
    expect(run?.env).toEqual(
      Object.fromEntries(
        secrets.map((name) => [name, `\${{ secrets.${name} }}`]),
      ),
    )
    expect(secrets).toEqual(["DISCORD_CHAD_TOKEN", "DISCORD_DRIVER_TOKEN"])
    expect(read("scripts/discord.ts")).toMatch(/"--project",\s*"discord"/)
    expect(readdirSync(path("test/discord"))).toEqual(["connect.test.ts"])
    expect(
      workflows.filter((workflow) => read(workflow).includes("secrets.")),
    ).toEqual([file])
  })

  it("TST-142 TST-206 every workflow that uses the bot tokens shares one concurrency group", () => {
    for (const workflow of workflows) {
      if (!read(workflow).includes("secrets.DISCORD_")) continue
      expect(yaml(workflow).concurrency).toEqual({
        group: "discord-bots",
        "cancel-in-progress": false,
      })
    }
    expect(nightly.concurrency.group).toBe("discord-bots")
  })

  it("TST-120 a failed night comments on the job's one open issue, and opens one only when there is none", () => {
    const report = steps.find((step) => step.if === "failure()")
    expect(report?.run).toContain('title="The nightly Discord job failed"')
    expect(report?.run).toMatch(
      /gh issue list --state open --search "in:title \$title"[\s\S]*if \[ -n "\$number" \]; then\s+gh issue comment "\$number"[\s\S]*else\s+gh issue create --title "\$title"/,
    )
    expect(nightly.permissions).toEqual({ contents: "read", issues: "write" })
  })
})
