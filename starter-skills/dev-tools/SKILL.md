---
name: dev-tools
description: Read before you clone or work on a code project, reach for a command line tool, or set up git and gh, to know which tools the image has, where a project goes and how git and gh get an identity and a GitHub token.
---

# Development tools

## What the image has

- Version control and GitHub: `git`, `gh`, `ssh`.
- Search and files: `rg` (ripgrep), `fd`, `tree`, `file`, `less`, `nvim`, `patch`, `rsync`.
- Data: `jq` for JSON, `sqlite3`.
- Fetching: `curl`, `wget`.
- Archives: `tar`, `zip`, `unzip`, `gzip`, `bzip2`, `xz`, `zstd`.
- Building: `make`.
- Languages: `node` with `npm` and `npx`, `python3` with no packages and no pip, and `uv`, which installs Python packages, Python versions and Python tools.

There is no C compiler, no apt and no sudo. Run `command -v <tool>` to check for anything else.

## Where projects go

Put a project you clone or make under `~/src/<name>`, which is `/data/home/src/<name>` on the volume and outlasts a restart and an image update. Never put one under `/data/repo`, which is chad's own repo.

```sh
git clone https://github.com/owner/project.git ~/src/project
```

## Setting up Git and gh

`~/.gitconfig` and gh's settings are on the volume. Leave whatever is set there alone. chad's own repo, `/data/repo/work`, has its own identity, and nothing here changes it.

```sh
# The name and email a commit in the project gets, from every config file and the files they include
git -C ~/src/project config user.name
git -C ~/src/project config user.email
# Only when one is missing, with what the owner gives you. Each writes to that project alone, and only when it has none
git -C ~/src/project config user.name >/dev/null || git -C ~/src/project config --local user.name "<name>"
git -C ~/src/project config user.email >/dev/null || git -C ~/src/project config --local user.email "<email>"
```

Ask the owner for the name and email, and never make one up. Use the same ones in their next project. A GitHub account's no-reply address keeps their real email out of public commits.

When `gh auth status` shows a login, or git already pushes to GitHub, use that as it is. Otherwise the owner saves a token in chad's secret store, as the `credentials` skill says, here as `GITHUB_TOKEN`, and each command that needs it gets it for that command alone:

```sh
chad secret run --env GH_TOKEN=GITHUB_TOKEN -- gh pr list --repo owner/project
# git gets the token from gh's helper, for this one command
chad secret run --env GH_TOKEN=GITHUB_TOKEN -- git -C ~/src/project -c credential.https://github.com.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' push
```

This puts no token in git's or gh's config, and changes neither. Don't run `gh auth login` or `gh auth setup-git` yourself, apart from the sign-in below: with no keyring here, a login is kept in plain text in `~/.config/gh/hosts.yml`, and `setup-git` replaces git's helpers for github.com. Use `https://github.com/...` remotes, never print a token, and never put one in a remote URL.

### When the owner would rather approve a sign-in

The owner can approve a sign-in on github.com from any browser, their phone included, instead of making a token. `github-login.sh`, next to this file, runs gh's device flow and saves the token as `GITHUB_TOKEN`, which is then used as above. Ask the owner first, and say that this token reaches every repo their account can, where a token they make can be limited to a few. In one script:

```js
const job = await bash({
  description: "GitHub sign-in",
  command: "sh /data/repo/live/skills/dev-tools/github-login.sh",
  background: true,
})
let task = await taskOutput(job.id)
while (
  task.status === "running" &&
  !/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(task.output)
) {
  await sleep(1000)
  task = await taskOutput(job.id)
}
const code = /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(task.output)?.[0]
if (code === undefined) throw new Error(task.output)
await sendMessage(
  `Open https://github.com/login/device, enter ${code} and approve. The code expires in 15 minutes.`,
)
while (task.status === "running") task = (await waitTasks({ ids: [job.id] }))[0]
console.log(task.status, task.exitCode)
```

Exit code 0 means the token is saved. A message the owner sends while it waits joins this turn, and the sign-in goes on. If the turn ends first, the sign-in still runs, and the next turn is told how it ended. Anything else means it failed or the code expired: say so, and start again if the owner wants. A `/new` or a restart of chad stops it.
