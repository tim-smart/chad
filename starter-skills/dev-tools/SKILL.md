---
name: dev-tools
description: Read before you clone or work on a code project, search a codebase, query JSON or SQLite, unpack an archive, or install a language, a runtime or a command line tool that is not in the image.
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

There is no C compiler, no apt and no sudo. Anything you install goes in your home directory, `/data/home`, which is on the volume and outlasts a restart and an image update. Run `command -v <tool>` before you install one.

## Projects

Put a project you clone or make under `~/src/<name>`, never under `/data/repo`, which is chad's own repo.

```sh
git clone https://github.com/owner/project.git ~/src/project
# A large repository: only the latest commit
git clone --depth 1 https://github.com/owner/project.git ~/src/project
```

Set the name and email you commit as in each project, with `git config user.name` and `git config user.email`. Ask the owner what to use the first time.

For GitHub, the `credentials` skill says how `gh` gets a token. Before you push, open a pull request or comment where other people see it, ask the owner.

## Searching code and data

```sh
# A pattern, with the line numbers, ignoring what .gitignore ignores
rg -n 'pattern' ~/src/project
# Only TypeScript files
rg -n -t ts 'pattern'
# Files by name
fd 'config' ~/src/project
# One field of each item of a JSON array
curl -fsS https://api.example.com/items | jq -r '.[].name'
# A SQLite database's tables, then a query
sqlite3 data.db '.tables'
sqlite3 -header -column data.db 'SELECT * FROM items LIMIT 10'
# A CSV file as a table to query
sqlite3 :memory: -cmd '.import --csv data.csv rows' 'SELECT count(*) FROM rows'
```

## Archives

```sh
# What an archive holds, before you unpack it
tar -tf archive.tar.gz
unzip -l archive.zip
# Unpack into a new directory
mkdir out && tar -xf archive.tar.gz -C out
mkdir out && unzip -q archive.zip -d out
# Pack a directory
tar -czf archive.tar.gz directory
zip -qr archive.zip directory
```

An archive from the internet or the owner can hold anything. Unpack it into a new, empty directory and read what came out before you run any of it.

## Node

```sh
# A project's dependencies
npm ci
# A tool once, without installing it
npx --yes prettier --check .
# A tool kept for every session, in ~/.npm-global/bin
npm install -g typescript
```

Node has no corepack. Install pnpm or yarn as any other global: `npm install -g pnpm`.

## Python

Use `uv`, never `pip`.

```sh
# A script's dependencies, for one run
uv run --with requests script.py
# A project: make it, add a package, run in its environment
uv init ~/src/tool && cd ~/src/tool && uv add httpx && uv run script.py
# A tool kept for every session, in ~/.local/bin
uv tool install ruff
# A tool once
uvx ruff check .
# Another Python version
uv python install 3.12
```

## Other languages

A language that has an installer for one user goes in your home directory, with its commands linked into `~/.local/bin`, which is on PATH. Ask the owner before you install one, as each takes hundreds of megabytes on the volume.

```sh
# Go: the release for this machine, unpacked into ~/.local/go
mkdir -p ~/.local && curl -fsSL "https://go.dev/dl/$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n 1).linux-$(dpkg --print-architecture).tar.gz" | tar -xz -C ~/.local
ln -sf ~/.local/go/bin/go ~/.local/go/bin/gofmt ~/.local/bin/
# Bun and Deno install themselves into your home directory
curl -fsSL https://bun.sh/install | bash
ln -sf ~/.bun/bin/bun ~/.local/bin/
curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path
ln -sf ~/.deno/bin/deno ~/.local/bin/
```

Go builds here with no C compiler, and a module that needs cgo does not. Rust, C and C++ need a C compiler and its linker, which the image does not have, so they cannot build anything. For a tool written in one of them, use a prebuilt binary from its releases, as below.

## A single binary from GitHub

Many tools publish a prebuilt binary with each release. Read the release page for the name of the file for Linux on this machine, then download it from the latest release with no token.

```sh
# amd64 or arm64, which a file name may call x86_64 or aarch64
dpkg --print-architecture
mkdir -p /tmp/tool && curl -fsSL https://github.com/owner/tool/releases/latest/download/tool-linux-amd64.tar.gz | tar -xz -C /tmp/tool
install -m 755 /tmp/tool/tool ~/.local/bin/
```

Check what you installed runs with `<tool> --version`.

## Tools the owner wants kept with the repo

A tool installed as above lives on the volume and nothing records it. A command line tool from npm can instead go in `work/package.json`, where an apply checks it and a revert takes it back. The `self-edit` skill says how.
