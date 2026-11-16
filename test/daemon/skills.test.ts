// Skills as the owner and the agent reach them: `skills/<name>/SKILL.md` reaches a session's prompt and `readSkill` once
// it is applied, a repo skill hides a bundled one of the same name, safe mode lists the bundled ones alone, a boot
// skips a malformed skill, and a bundled skill that changed under a repo skill is announced once
// (docs/spec/12-skills-and-mcp.md, 14-self-edit-skill.md). The last test holds clanka's own walk.
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Skills from "../../dist/Skills.js"
import { applied, write } from "../support/applied.ts"
import { fresh, scenario, type Scenario } from "../support/driver.ts"
import { type Call, results, runs } from "../support/model.ts"
import { lines, rows, says } from "../support/owner.ts"

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

/** One owner turn, which runs a script when it is given, and the system prompt and what the script printed. */
const turn = async (
  running: Scenario,
  thread: ChatThread.ChatThread,
  script?: string,
) => {
  const ended = running
    .log()
    .filter((line) => line.annotations["event"] === "turn.ended").length
  await running.fakes.model.script(
    script === undefined ? [{ text: "ok" }] : [runs(script), { text: "ok" }],
  )
  await says(running, thread, "go")
  await lines(running, "turn.ended", ended + 1)
  const calls = await running.fakes.model.calls()
  return {
    system: systemText(calls[0]),
    printed: script === undefined ? "" : (results(calls[1]).at(-1) ?? ""),
  }
}

const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

const events = (running: Scenario, event: string) =>
  running.log().filter((line) => line.annotations["event"] === event)

/** The `notices` rows of the skills' keys. */
const skillNotices = (running: Scenario) =>
  rows(
    running,
    "SELECT key, text FROM notices WHERE key LIKE 'skill-%' ORDER BY key",
  )

test("MCP-1 MCP-2 MCP-3 MCP-4 MCP-5 MCP-7 MCP-8 MCP-10 MCP-11 MCP-12 MCP-13 MCP-14 MCP-16 MCP-17 MCP-18 MCP-102 MCP-103 MCP-104 MCP-105 MCP-106 MCP-107 MCP-145 MCP-146 MCP-147 SELF-55 SELF-56 SELF-57 SELF-59 SELF-60 SELF-61 SELF-117 SELF-119 SELF-120 SELF-121 SELF-139 REC-47 REC-51 SWAP-9 LOAD-87 CLI-67 CLI-68 CLI-70 CLI-75 CLI-84 CLI-85 CLI-156 FAIL-166 FAIL-234 FAIL-167 TST-217 an applied skill reaches the next turn's prompt and readSkill, hides a bundled one, leaves safe mode, and a boot skips a malformed one and announces a changed bundled skill once", async () => {
  const bundled = join(fresh(), "bundled")
  write(bundled, {
    "alpha/SKILL.md": skill("alpha", "Bundled alpha.", "alpha body"),
    "notes/SKILL.md": skill("notes", "Bundled notes.", "bundled notes body"),
    "notes/ref.txt": "first image\n",
  })
  const first = await scenario({ skills: bundled })
  const work = join(first.data, "repo/work")
  const thread = await first.fakes.chat.makeThread("direct")

  // The bundled skills are listed and read with where their files are. A first boot stores their hashes silently.
  const start = await turn(
    first,
    thread,
    'console.log(await readSkill("notes"))',
  )
  expect(start.system).toContain("- alpha: Bundled alpha.")
  expect(start.system).toContain("- notes: Bundled notes.")
  expect(start.printed).toContain("bundled notes body")
  expect(start.printed).toContain(
    Messages.bundledSkillWhere(
      join(bundled, "notes"),
      join(work, "skills/notes"),
    ),
  )
  expect(
    Object.keys(
      JSON.parse(
        readFileSync(join(first.data, "state/bundled-skills.json"), "utf8"),
      ),
    ),
  ).toEqual(["alpha", "notes"])
  expect(events(first, "skill.bundled-changed")).toEqual([])

  // `chad skill new` writes a draft and nothing else, and refuses a taken name and one that breaks the name rule.
  expect(await first.chad(["skill", "new", "mine"])).toMatchObject({
    code: 0,
    stdout: Messages.skillWritten("mine") + "\n",
  })
  expect(readFileSync(join(work, "skills/mine/SKILL.md"), "utf8")).toBe(
    Skills.template("mine"),
  )
  expect((await first.chad(["skill", "new", "mine"])).code).toBe(1)
  expect((await first.chad(["skill", "new", "Mine_1"])).code).toBe(2)

  // A check and an apply refuse a malformed skill and name its file. The drafts reach no session.
  write(work, {
    "skills/notes/SKILL.md": skill("notes", "Repo notes.", "repo notes body"),
    "skills/bad/SKILL.md": skill("other", "Misnamed.", "bad body"),
    "skills/raw/SKILL.md": "no front matter\n",
  })
  const refusals = [
    Messages.skillRefused(
      "bad",
      Messages.skillProblems.otherName("other", "bad"),
    ),
    Messages.skillRefused("mine", Messages.skillProblems.noDescription),
    Messages.skillRefused("raw", Messages.skillProblems.noFrontMatter("raw")),
  ]
  for (const command of [["check"], ["apply", "-m", "Skills"]]) {
    const refused = await first.chad(command)
    expect(refused.code).toBe(1)
    for (const line of refusals) expect(refused.stderr).toContain(line)
  }
  const draft = await turn(first, thread)
  expect(draft.system).toContain("- notes: Bundled notes.")
  expect(draft.system).not.toContain("mine")

  // Applied, the repo skills reach the open session at its next turn, through repo/live, and the repo's notes wins.
  rmSync(join(work, "skills/bad"), { recursive: true })
  rmSync(join(work, "skills/raw"), { recursive: true })
  write(work, {
    "skills/mine/SKILL.md": skill("mine", "My skill.", "mine body"),
  })
  const apply = await first.chad(["apply", "-m", "Skills"])
  expect(apply.code).toBe(0)
  expect(apply.stdout).toContain(
    [
      ...Messages.skillChanges({
        added: ["mine", "notes"],
        changed: [],
        removed: [],
      }),
      Messages.skillHides("notes"),
      "",
    ].join("\n"),
  )
  const live = await turn(
    first,
    thread,
    'console.log(await readSkill("mine")); console.log(await readSkill("notes"))',
  )
  expect(live.system).toContain("- mine: My skill.")
  expect(live.system).toContain("- notes: Repo notes.")
  expect(live.system).not.toContain("Bundled notes.")
  expect(live.printed).toContain(
    Messages.repoSkillWhere(
      join(first.data, "repo/live/skills/mine"),
      join(work, "skills/mine"),
    ),
  )
  expect(live.printed).toContain("repo notes body")
  expect(live.printed).not.toContain("bundled notes body")
  const mark = Messages.skillHidesMark("notes")
  expect((await first.chad(["status"])).stdout).toContain(mark)

  // Safe mode lists the bundled skills alone.
  expect((await first.chad(["safe", "on"])).code).toBe(0)
  const safe = await turn(first, thread)
  expect(safe.system).toContain("- notes: Bundled notes.")
  expect(safe.system).toContain("- alpha: Bundled alpha.")
  expect(safe.system).not.toContain("My skill.")
  expect((await first.chad(["status"])).stdout).not.toContain(mark)
  expect((await first.chad(["safe", "off"])).code).toBe(0)

  // A removed skill is gone at the next turn.
  rmSync(join(work, "skills/mine"), { recursive: true })
  const removal = await first.chad(["apply", "-m", "No mine"])
  expect(removal.stdout).toContain(
    Messages.skillChanges({ added: [], changed: [], removed: ["mine"] })[0],
  )
  const removed = await turn(first, thread)
  expect(removed.system).not.toContain("My skill.")
  expect(removed.system).toContain("- notes: Repo notes.")
  expect(await first.stop()).toBe(0)

  // A restore leaves a malformed skill in the applied tree, and a new image changes the bundled notes the repo hides.
  applied(join(first.data, "repo"), {
    "skills/broken/SKILL.md": "---\nname: broken\n---\n\nbroken body\n",
  })
  write(bundled, { "notes/ref.txt": "second image\n" })
  const skipped = Messages.skillSkipped(
    "broken",
    Messages.skillProblems.noDescription,
  )
  const second = await scenario({ directory: first.directory, skills: bundled })
  // A thread of its own, as the platform starts again with no memory of the message ids the first boot took.
  await second.fakes.chat.makeThread("direct")
  const booted = await turn(
    second,
    await second.fakes.chat.makeThread("direct"),
  )
  expect(booted.system).toContain("- notes: Repo notes.")
  expect(booted.system).not.toContain("broken")
  expect(events(second, "skill.skipped")).toHaveLength(1)
  expect(events(second, "skill.bundled-changed")).toHaveLength(1)
  expect(skillNotices(second)).toEqual([
    { key: "skill-skipped:broken", text: skipped },
  ])
  expect(await second.stop()).toBe(0)

  // The next boot finds the stored hash and says nothing of the bundled skill again, and an apply clears the notice.
  const third = await scenario({ directory: first.directory, skills: bundled })
  await third.logged("boot.ready")
  expect(events(third, "skill.bundled-changed")).toHaveLength(1)
  expect((await third.chad(["status"])).stdout).toContain(skipped)
  rmSync(join(third.data, "repo/work/skills/broken"), { recursive: true })
  expect((await third.chad(["apply", "-m", "No broken"])).code).toBe(0)
  expect((await third.chad(["status"])).stdout).not.toContain(skipped)
  expect(await third.stop()).toBe(0)
})

test("MCP-132 MCP-133 OV-36 SWAP-149 with a list of skills passed, clanka's walk from a directory outside the session's shows the AGENTS.md files and skills up to the git root, the outermost first, and nothing above it", async () => {
  const bundled = join(fresh(), "bundled")
  write(bundled, {
    "alpha/SKILL.md": skill("alpha", "Bundled alpha.", "alpha body"),
  })
  const root = join(fresh(), "walk")
  write(root, {
    "AGENTS.md": "ABOVE THE GIT ROOT\n",
    "top/AGENTS.md": "TOP INSTRUCTIONS\n",
    "top/a/AGENTS.md": "INNER INSTRUCTIONS\n",
    "top/a/b/.agents/skills/walked/SKILL.md": skill(
      "walked",
      "A walked skill.",
      "walked body",
    ),
  })
  mkdirSync(join(root, "top/.git"))
  const running = await scenario({ skills: bundled })
  const thread = await running.fakes.chat.makeThread("direct")
  const { system } = await turn(
    running,
    thread,
    `await changeDirectory(${JSON.stringify(join(root, "top/a/b"))}); console.log("moved")`,
  )
  expect(system).toContain("- alpha: Bundled alpha.")
  const after = JSON.stringify((await running.fakes.model.calls())[1]?.body)
  const update = after.slice(after.indexOf("<environment-update>"))
  expect(update).toContain("TOP INSTRUCTIONS")
  expect(update).toContain("INNER INSTRUCTIONS")
  expect(update).toContain("walked")
  expect(update.indexOf("TOP INSTRUCTIONS")).toBeLessThan(
    update.indexOf("INNER INSTRUCTIONS"),
  )
  expect(update.indexOf("INNER INSTRUCTIONS")).toBeLessThan(
    update.indexOf("walked"),
  )
  expect(after).not.toContain("ABOVE THE GIT ROOT")
})
