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

`~/.gitconfig` and gh's settings are on the volume, so the setup is done once. Check what is set before you change anything, and leave a value that is there alone. chad's own repo, `/data/repo/work`, has its own identity in its own config, and nothing here changes it.

```sh
# The identity commits are made with. Each exits 1 when it is not set
git config --global --get user.name
git config --global --get user.email
# Only for one that is missing, with the name and email the owner gives you
git config --global user.name "<name>"
git config --global user.email "<email>"
# A project that needs another identity sets it in the project alone, without --global
git -C ~/src/project config user.email "<email>"
```

Ask the owner for the name and email. Never make one up. A GitHub account's no-reply address keeps their real email out of public commits.

For GitHub, the token stays in chad's secret store. The `credentials` skill says how the owner saves it with `requestSecret`. Here it is named `GITHUB_TOKEN`. `gh` reads it from `GH_TOKEN` in one command's environment, and git gets it through gh, so no file on the volume holds it.

```sh
# Whether gh is signed in already, and whether git already has a helper for github.com
gh auth status
git config --global --get-regexp '^credential\.https://github\.com'
# Only when the second printed nothing: let git ask gh for the token when it talks to github.com. This writes no token
chad secret run --env GH_TOKEN=GITHUB_TOKEN -- gh auth setup-git --hostname github.com
# Then every command that needs the token runs through chad secret run
chad secret run --env GH_TOKEN=GITHUB_TOKEN -- gh pr list --repo owner/project
chad secret run --env GH_TOKEN=GITHUB_TOKEN -- git -C ~/src/project push
```

Use `https://github.com/...` remotes. Prefer this to `gh auth login --with-token`: with no keyring in the image, that writes the token in plain text to `~/.config/gh/hosts.yml`, where any command can read it, while the secret store gives it only to the command you run. If `gh auth status` shows a login that is already there, use it as it is. Never print a token, and never put one in a remote URL.
