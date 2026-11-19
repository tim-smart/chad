---
name: dev-tools
description: Read before you clone or work on a code project, or reach for a command line tool, to know which tools the image has and where a project goes.
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
