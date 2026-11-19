// The owner-assisted GitHub sign-in of the `dev-tools` starter skill, run as the skill writes it, with a `gh` that
// stands in for GitHub: chad posts the code during the turn, a message the owner sends while the sign-in waits joins
// that turn without stopping it, and the token reaches the secret store and nothing the owner, the model or the log
// sees, and no config file.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import sendMessage from "../../dist/plugins/send-message.js"
import * as Skills from "../../dist/Skills.js"
import { fresh, scenario } from "../support/driver.ts"
import { printed, runs } from "../support/model.ts"
import { eventually, lines, posted, says, sessions } from "../support/owner.ts"
import { blocks, toolbox } from "../support/skills.ts"

test("chad posts the device code, the owner's reply joins the waiting turn, and the token is saved and shown nowhere", async () => {
  const directory = fresh()
  const data = join(directory, "data")
  const token = "gho_device-token-5b1d93"
  const approved = join(directory, "approved")
  const used = join(directory, "config-dir")
  // gh's side of the device flow: the code and the address, a wait for the owner's approval, then the login in gh's
  // config directory, which `gh auth token` prints.
  const bin = toolbox(join(directory, "bin"), [])
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      '"auth login")',
      '  echo "! First copy your one-time code: WXYZ-1234" >&2',
      '  echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2',
      `  while [ ! -e "${approved}" ]; do sleep 0.05; done`,
      `  mkdir -p "$GH_CONFIG_DIR" && printf '%s' "${token}" > "$GH_CONFIG_DIR/hosts.yml" && echo "$GH_CONFIG_DIR" > "${used}"`,
      '  echo "Logged in" >&2 ;;',
      '"auth token") cat "$GH_CONFIG_DIR/hosts.yml" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  const skill = readFileSync(
    join(Skills.starterDirectory, "dev-tools/SKILL.md"),
    "utf8",
  )
  const command = "sh /data/repo/live/skills/dev-tools/github-login.sh"
  const script = blocks(skill).find(({ body }) => body.includes(command))!.body
  const running = await scenario({
    directory,
    starters: Skills.starterDirectory,
    plugins: [{ name: "send-message", plugin: sendMessage }],
  })
  await running.fakes.model.script([
    runs(
      script.replace(
        command,
        `PATH=${bin}:$PATH CHAD_DATA=${data} sh ${data}/repo/live/skills/dev-tools/github-login.sh`,
      ),
    ),
    { text: "signed in" },
    // What the sign-in printed, as the model reads it from its task.
    runs("console.log(JSON.stringify(await listTasks()))"),
    { text: "read" },
  ])
  const thread = await running.fakes.chat.makeThread("direct")
  await says(running, thread, "sign in to GitHub")

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

  // One turn: the sign-in's script, then the answer, with the owner's reply read in between.
  await lines(running, "turn.steered", 1)
  const calls = await running.fakes.model.calls()
  expect(calls).toHaveLength(2)
  expect(printed(calls[1]).join("")).toContain("completed 0")
  expect(JSON.stringify(calls[1]?.body)).toContain("approved it")
  expect(await posted(running, thread)).toEqual([
    expect.stringContaining("https://github.com/login/device"),
    "signed in",
  ])
  expect((await running.chad(["secret", "list"])).stdout).toContain(
    "GITHUB_TOKEN",
  )
  expect(
    (
      await running.chad(
        ["secret", "run", "--stdin", "GITHUB_TOKEN", "--", "cat"],
        {},
      )
    ).stdout,
  ).toBe(token)

  // The token is in nothing the owner, the model or the log saw, the task's output included, gh's directory is gone,
  // and no config changed.
  await says(running, thread, "what did it print")
  await running.fakes.chat.answers(thread, 3)
  const read = await running.fakes.model.calls()
  expect(printed(read[3]).join("")).toContain("Logged in")
  const seen = [
    JSON.stringify(await running.fakes.chat.messages(thread)),
    JSON.stringify(read.map(({ body }) => body)),
    JSON.stringify(running.log()),
    readFileSync(join(data, "logs/chad.log"), "utf8"),
  ]
  for (const text of seen) expect(text).not.toContain(token)
  expect(existsSync(readFileSync(used, "utf8").trim())).toBe(false)
  expect(existsSync(join(data, "home/.config/gh"))).toBe(false)
  expect(existsSync(join(data, "home/.gitconfig"))).toBe(false)
  expect(await running.stop()).toBe(0)
})
