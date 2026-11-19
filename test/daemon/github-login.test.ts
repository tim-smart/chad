// The first-use GitHub sign-in of the `dev-tools` starter skill, run as the skill writes it, with a `gh` that stands in
// for GitHub: the skill's login check fails, chad posts the device code during the turn, a message the owner sends
// while the sign-in waits joins that turn without stopping it, and afterwards the check passes in a later turn, git
// has gh's helper and the account's identity, and the token is in nothing the owner, the model or the log sees.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import sendMessage from "../../dist/plugins/send-message.js"
import * as Skills from "../../dist/Skills.js"
import { fresh, scenario } from "../support/driver.ts"
import { printed, results, runs } from "../support/model.ts"
import { eventually, lines, posted, says, sessions } from "../support/owner.ts"
import { blocks, toolbox } from "../support/skills.ts"

/** A volume directory, a `gh` that stands in for GitHub, and the skill's check and sign-in script set up to use them. */
const prepare = () => {
  const directory = fresh()
  const data = join(directory, "data")
  const token = "gho_device-token-5b1d93"
  const approved = join(directory, "approved")
  const pid = join(directory, "gh.pid")
  // gh's side: a login in gh's config directory once the owner approves, which `auth status` then finds.
  const bin = toolbox(join(directory, "bin"), [])
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'config="${GH_CONFIG_DIR:-$HOME/.config/gh}"',
      'case "$1 $2" in',
      '"auth status") test -s "$config/hosts.yml" ;;',
      '"auth login")',
      `  echo $$ > "${pid}"`,
      '  echo "! First copy your one-time code: WXYZ-1234" >&2',
      '  echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2',
      `  while [ ! -e "${approved}" ]; do sleep 0.05; done`,
      `  mkdir -p "$config" && printf 'github.com:\\n  oauth_token: ${token}\\n' > "$config/hosts.yml"`,
      '  echo "Logged in" >&2 ;;',
      "\"auth setup-git\") git config --global credential.https://github.com.helper '!gh auth git-credential' ;;",
      "\"api user\") printf '42\\toctocat\\tMona Octo\\n' ;;",
      "*) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  const skill = readFileSync(
    join(Skills.starterDirectory, "dev-tools/SKILL.md"),
    "utf8",
  )
  // The skill's commands run as written, after the variables a session of the image has.
  const exports = `export PATH=${bin}:$PATH CHAD_DATA=${data};`
  const check = "gh auth status --hostname github.com"
  expect(blocks(skill).some(({ body }) => body.trim() === check)).toBe(true)
  const command =
    'sh "${CHAD_DATA:-/data}/repo/live/skills/dev-tools/github-login.sh"'
  const script = blocks(skill)
    .find(({ body }) => body.includes(command))!
    .body.replace(`'${command}'`, JSON.stringify(`${exports} ${command}`))
  // clanka's bash fails a command that exits non-zero, so the check prints its own exit code.
  const checks = runs(
    `console.log((await bash({ description: "login check", command: ${JSON.stringify(`${exports} ${check}; echo "check $?"`)} })).output)`,
  )
  return { directory, data, token, approved, pid, script, checks }
}

test("the login check fails, chad posts the device code, the owner's reply joins the waiting turn, and the next turn's check passes with git set up and the token shown nowhere", async () => {
  const { directory, data, token, approved, script, checks } = prepare()
  const home = join(data, "home")
  const running = await scenario({
    directory,
    starters: Skills.starterDirectory,
    plugins: [{ name: "send-message", plugin: sendMessage }],
  })
  await running.fakes.model.script([
    checks,
    runs(script),
    { text: "signed in" },
    checks,
    { text: "still signed in" },
  ])
  const thread = await running.fakes.chat.makeThread("direct")
  await says(running, thread, "clone my project")

  // The code reaches the owner while the turn runs. Their reply waits to join it: chad saves a waiting message's file
  // when the message reaches the turn. Only then does the owner's approval let gh finish.
  await eventually(
    () => posted(running, thread),
    (texts) => texts.some((text) => text.includes("WXYZ-1234")),
  )
  await says(running, thread, "approved it", {
    files: [
      {
        name: "note.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("a note"),
      },
    ],
  })
  const inbox = join(
    data,
    "sessions",
    String(sessions(running)[0]?.["id"]),
    "inbox",
  )
  await eventually(
    () => (existsSync(inbox) ? readdirSync(inbox) : []),
    (files) => files.length > 0,
  )
  writeFileSync(approved, "")
  await running.fakes.chat.answers(thread, 2)
  await lines(running, "turn.steered", 1)

  // A later turn's check passes, with no second login.
  await says(running, thread, "push it")
  await running.fakes.chat.answers(thread, 3)
  const calls = await running.fakes.model.calls()
  expect(calls).toHaveLength(5)
  expect(printed(calls[1]).join("")).toContain("check 1")
  expect(printed(calls[2]).join("")).toContain("completed 0")
  expect(printed(calls[2]).join("")).toContain(
    "git commits as Mona Octo <42+octocat@users.noreply.github.com>",
  )
  expect(JSON.stringify(calls[2]?.body)).toContain("approved it")
  expect(printed(calls[4]).join("")).toContain("check 0")
  expect(await posted(running, thread)).toEqual([
    expect.stringContaining("https://github.com/login/device"),
    "signed in",
    "still signed in",
  ])
  const git = (key: string) =>
    execFileSync("git", ["config", "--global", key], {
      env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
      encoding: "utf8",
    }).trim()
  expect(git("user.name")).toBe("Mona Octo")
  expect(git("user.email")).toBe("42+octocat@users.noreply.github.com")
  expect(git("credential.https://github.com.helper")).toBe(
    "!gh auth git-credential",
  )

  // The token is in gh's own login file and in nothing the owner, the model or the log saw.
  expect(readFileSync(join(home, ".config/gh/hosts.yml"), "utf8")).toContain(
    token,
  )
  const seen = [
    JSON.stringify(await running.fakes.chat.messages(thread)),
    JSON.stringify(calls.map(({ body }) => body)),
    JSON.stringify(running.log()),
    readFileSync(join(data, "logs/chad.log"), "utf8"),
  ]
  for (const text of seen) expect(text).not.toContain(token)
  expect(await running.stop()).toBe(0)
})

test("a sign-in whose code cannot reach the owner is stopped, gh with it, and the turn says so in fixed words", async () => {
  const { directory, data, pid, script } = prepare()
  // No sendMessage, so handing the code over fails.
  const running = await scenario({
    directory,
    starters: Skills.starterDirectory,
  })
  await running.fakes.model.script([runs(script), { text: "could not" }])
  const thread = await running.fakes.chat.makeThread("direct")
  await says(running, thread, "clone my project")
  await running.fakes.chat.answers(thread, 1)

  const calls = await running.fakes.model.calls()
  // The error is the script's own words, which clanka shows as a log line.
  expect(results(calls[1]).join("")).toContain(
    "The GitHub sign-in could not give the owner its code, so it was stopped.",
  )
  expect(results(calls[1]).join("")).not.toContain("WXYZ-1234")
  const gh = Number(readFileSync(pid, "utf8"))
  await eventually(
    () => {
      try {
        process.kill(gh, 0)
        return true
      } catch {
        return false
      }
    },
    (alive) => !alive,
  )
  expect(existsSync(join(data, "home/.config/gh"))).toBe(false)
  expect(await running.stop()).toBe(0)
})
