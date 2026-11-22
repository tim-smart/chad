---
name: dev-tools
description: Read when cloning or creating a code project. Covers where projects go, first-time git and gh setup, and the tools installed in the image.
---

# Cloning or creating a code project

## Where projects go

Put projects under `~/src/<name>` (`/data/home/src/<name>` on the data volume), which persists across restarts and image updates. Never put a project under `/data/repo`, which is chad's own repo. Use `https://github.com/...` URLs.

```sh
git clone https://github.com/owner/project.git ~/src/project
git init ~/src/new-project
```

## First-time git and gh setup

Before your first clone, push, or `gh` command, check if `gh` is already signed in:

```sh
gh auth status --hostname github.com
```

If it exits 0, `git` and `gh` are ready to go.

If not, run `github-login.sh` next to this file. It signs `gh` in with a device code that the owner approves on github.com from any browser, configures `git` to use that login, and sets a global git name and email (using the GitHub account's name and no-reply address) unless `~/.gitconfig` already has one. The setup persists on the volume for future sessions. Let the owner know this login grants access to every repo their account can access. Run it in one script:

```js
let task = await bash({
  description: "GitHub sign-in",
  command:
    'sh "${CHAD_DATA:-/data}/repo/live/skills/dev-tools/github-login.sh"',
  background: true,
})
const pattern = /[A-Z0-9]{4}-[A-Z0-9]{4}/
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
while (task.status === "running")
  task = (await waitTasks({ ids: [task.id] }))[0]
console.log(task.status, task.exitCode, task.output)
```

Exit code 0 means sign-in succeeded and the output names the GitHub account; tell the owner which account signed in. Messages the owner sends while it waits are folded into this turn without interrupting the login. Any nonzero exit means it failed or the code expired; tell the owner and offer to run it again. `/new` or a chad restart cancels it. Never print a token or embed one in a URL.

## Preinstalled tools

- **Version control and GitHub**: `git`, `gh`, `ssh`
- **Search and files**: `rg` (ripgrep), `fd`, `tree`, `file`, `less`, `nvim`, `patch`, `rsync`
- **Data**: `jq` (JSON), `sqlite3`
- **Fetching**: `curl`, `wget`
- **Archives**: `tar`, `zip`, `unzip`, `gzip`, `bzip2`, `xz`, `zstd`
- **Building**: `make`
- **Languages**: `node` (`npm`, `npx`), `python3` (stdlib only, no `pip`), and `uv` (installs Python versions, packages, and tools)

There is no C compiler, no `apt`, and no `sudo`. Check for anything else with `command -v <tool>`.
