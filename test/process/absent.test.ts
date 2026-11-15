import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, onTestFinished } from "vitest"
import { chad } from "../support/cli.ts"

it("CLI-137a STO-133a FAIL-108a v1 has no plugin list, enable, disable or remove, no mcp add, no config, no chad turns, and no command for sessions, a reload, a turn, scheduled jobs or a skill merge or diff: each is a usage error", async () => {
  const data = mkdtempSync(join(tmpdir(), "chad-absent-"))
  onTestFinished(() => rmSync(data, { recursive: true, force: true }))
  const absent = [
    ["plugin", "list"],
    ["plugin", "enable", "cron"],
    ["plugin", "disable", "cron"],
    ["plugin", "remove", "cron"],
    ["mcp", "add", "server"],
    ["config"],
    ["turns"],
    ["session"],
    ["sessions"],
    ["reload"],
    ["turn", "hello"],
    ["cron"],
    ["jobs"],
    ["skill", "merge"],
    ["skill", "diff"],
    // The database commands are query and check, and the turns table is read with a query.
    ["db", "turns"],
  ]
  const runs = await Promise.all(
    absent.map((args) => chad(args, { CHAD_DATA: data })),
  )
  for (const [index, args] of absent.entries()) {
    const ran = runs[index]!
    expect(ran.code, args.join(" ")).toBe(2)
    expect(ran.stdout).toMatch(/USAGE\n {2}chad /)
    expect(ran.stderr).toContain(
      `Unknown subcommand "${args.at(0) === "db" ? args[1] : args[0]}"`,
    )
  }
  expect(readdirSync(data)).toEqual([])
})
