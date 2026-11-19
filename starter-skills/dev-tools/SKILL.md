---
name: dev-tools
description: Read when cloning or creating a code project. Covers where projects go, setting up git and gh the first time, and the tools the image has.
---

# Cloning or creating a code project

## Where projects go

Put each project under `~/src/<name>`, which is `/data/home/src/<name>` on the volume and outlasts a restart and an image update. Never put one under `/data/repo`, which is chad's own repo. Use `https://github.com/...` addresses.

```sh
git clone https://github.com/owner/project.git ~/src/project
git init ~/src/new-project
```

## First use: git and gh

Before the first clone, push or `gh` command, check that gh is signed in:

```sh
gh auth status --hostname github.com
```

If it exits 0, git and gh are set up. Go on.

If it does not, run `github-login.sh`, next to this file. It signs gh in with a code the owner approves on github.com from any browser, and sets git up to use that login. It also gives git a global name and email, the GitHub account's name and no-reply address, unless `~/.gitconfig` already has one. The setup stays on the volume, so later sessions pass the check. Tell the owner the login reaches every repo their account can. In one script:

```js
let task = await bash({
  description: "GitHub sign-in",
  command:
    'sh "${CHAD_DATA:-/data}/repo/live/skills/dev-tools/github-login.sh"',
  background: true,
})
const pattern = /[A-Z0-9]{4}-[A-Z0-9]{4}/
try {
  for (
    let waited = 0;
    task.status === "running" && !pattern.test(task.output);
    waited += 1000
  ) {
    if (waited >= 60_000) throw new Error("no code")
    await sleep(1000)
    task = await taskOutput(task.id)
  }
  const code = pattern.exec(task.output)?.[0]
  if (code !== undefined)
    await sendMessage(
      `Open https://github.com/login/device, enter ${code} and approve. The code expires in 15 minutes.`,
    )
} catch {
  await stopTask(task.id).catch(() => {})
  throw new Error(
    "The GitHub sign-in could not give the owner its code, so it was stopped.",
  )
}
while (task.status === "running")
  task = (await waitTasks({ ids: [task.id] }))[0]
console.log(task.status, task.exitCode, task.output)
```

Exit code 0 means it is done, and the output names the GitHub account. Tell the owner which account it is. A message the owner sends while it waits joins this turn, and the sign-in goes on. Anything else means it failed or the code expired: say so, and run it again if the owner wants. A `/new` or a restart of chad stops it. Never print a token or put one in an address.

## What the image has

- Version control and GitHub: `git`, `gh`, `ssh`.
- Search and files: `rg` (ripgrep), `fd`, `tree`, `file`, `less`, `nvim`, `patch`, `rsync`.
- Data: `jq` for JSON, `sqlite3`.
- Fetching: `curl`, `wget`.
- Archives: `tar`, `zip`, `unzip`, `gzip`, `bzip2`, `xz`, `zstd`.
- Building: `make`.
- Languages: `node` with `npm` and `npx`, `python3` with no packages and no pip, and `uv`, which installs Python packages, Python versions and Python tools.

There is no C compiler, no apt and no sudo. Run `command -v <tool>` to check for anything else.
