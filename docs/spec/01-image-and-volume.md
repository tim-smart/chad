# Docker image and data volume layout

chad ships as one Docker image and keeps all of its own state on one data volume. This part covers what the image contains, the user it runs as, its entrypoint and environment variables, the directory tree on the volume, how the pinned packages are installed, what the daemon checks at boot, the health probe, the stop sequence, the exit codes of the daemon, and the Kubernetes example. "The daemon" is the long-running process started by `chad serve`. "The agent" is the clanka agent that runs a turn for the owner, and its commands run in the same container and as the same user as the daemon. This part leans on 02-storage.md for the database, backup and restore, on 10-cli.md for the commands, the lock and the socket, on 09-repo-and-recovery.md for the repo and safe mode, on 16-failures-logs-status.md for the logs and for what the owner sees, and on 17-testing.md for the tests and CI.

Three questions about this part were open with Tim: the deadline of a stop, what `CHAD_DATA` is for, and why `CHAD_SOCKET` exists. Tim handed them to Jarvis on 2026-11-15, and the answers that had been provisional stand as rules: IMG-29, IMG-30, IMG-63, IMG-82, IMG-83, IMG-139 and IMG-140. Tim has not read them.

## The image

The image is built from a two-stage Dockerfile. The first stage installs the packages and builds chad, and the second stage is what runs. Built around a stand-in daemon, it measured 697 MB unpacked, 197 MB compressed for amd64 and 194 MB compressed for arm64. The largest parts unpacked are `node_modules` at 243 MB, the Node binary at 144 MB and uv at 41 MB.

- **IMG-1** The base image is `node:26-trixie-slim`, pinned by digest. It is not Alpine. chad runs on Node 26.
- **IMG-2** The chad repo runs Renovate or Dependabot to bump the pinned digest, because a pinned digest also stops security fixes.
- **IMG-3** The image adds these Debian packages with `--no-install-recommends`: git, ripgrep, sqlite3, curl, ca-certificates, jq, procps, openssh-client, unzip, xz-utils and tini. It adds gh from GitHub's apt repository and not from Debian's.
- **IMG-4** The image carries uv and uvx at a pinned version.
- **IMG-5** The image's `node_modules` carries TypeScript 7 and esbuild with its native binary for the image's platform. The image has no Python package and no compiler toolchain.
- **IMG-6** The JavaScript of `@anthropic-ai/claude-agent-sdk` stays in the image, because clanka imports it. Its 349 MB platform binary, which is Claude Code, is left out with pnpm `ignoredOptionalDependencies` entries. Keeping the JavaScript makes no provider usable, and which providers chad refuses is in 05-model-and-login.md.
- **IMG-7** The image's CI imports `clanka/ClaudeAgent` and fails if the platform binary's package is in `node_modules`.
- **IMG-8** The image never carries a browser. An owner who wants one adds it on their own (see 15-credentials.md).
- **IMG-9** The image is `ghcr.io/tim-smart/chad`, built for amd64 and tagged by version.
- **IMG-121** The image's version tag is the chad package's version with no prefix. It is the same string that `state/version` holds and `chad status` prints, so an owner can match a tag to a running chad.
- **IMG-10** The image exposes no port, keeps `STOPSIGNAL` at SIGTERM and has no `VOLUME` line in its Dockerfile.
- **IMG-11** The image carries effect's `AGENTS.md` and `ai-docs/` for the effect version it pins. They sit in the effect package of the image's `node_modules`, which is reachable at `/data/repo/node_modules/effect/` once the link of IMG-44 exists. If the vendored snapshot lacks either, the image build produces it from effect's source at the commit that the manifest under `vendor/` names, and the image build fails when it cannot (see 14-self-edit-skill.md for that step). The files are never taken from another published version.
- **IMG-12** CI on the image checks every path, command, flag, exit code and quoted message in each of the three bundled skills, including `/data/repo/examples/` and the two examples the `self-edit` skill names (see 14-self-edit-skill.md for the checks and 17-testing.md for where they run).
- **IMG-111** The image carries three bundled skills, which are `self-edit`, `credentials` and `diagnose` (see 14-self-edit-skill.md, 15-credentials.md and 16-failures-logs-status.md).
- **IMG-112** The image carries the client of the `local` connection kind. It carries neither the platform that client talks to at `run/local.sock` nor an interactive client (see 17-testing.md).
- **IMG-113** The image, the examples and the boot, lock and stop rules of this part are tested in the layers that 17-testing.md defines. The checks that IMG-7, IMG-12, IMG-56 and IMG-61 name are tests in that suite.

In the image run the vendored snapshot held both, `AGENTS.md` at 19,459 bytes and 79 files under `ai-docs/src`, so the fallback of IMG-11 has never run.

The Dockerfile below is the one that was built and run on Docker CE 29.9.3. The digest and the versions of pnpm (12.18.0) and uv (0.13.8) are the ones that build used. The tickets fix only that each is pinned.

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE=docker.io/library/node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
ARG UV=ghcr.io/astral-sh/uv:0.13.8

FROM ${UV} AS uv

FROM ${NODE} AS build
RUN npm install -g --no-audit --no-fund pnpm@12.18.0
WORKDIR /opt/chad
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY bin ./bin
COPY src ./src
COPY plugins ./plugins
# The self-link is what makes `import { Plugin } from "chad"` resolve from /data/repo/node_modules.
RUN pnpm run build && ln -s .. node_modules/chad && pnpm run check:plugins && chmod +x bin/chad.js
# The checks the image's CI makes: one effect, no Claude platform binary, and clanka's Claude module still imports.
RUN test "$(find node_modules -name package.json -path '*/node_modules/effect/package.json' | wc -l)" = 1 \
 && test -z "$(find node_modules/.pnpm -maxdepth 1 -name '@anthropic-ai+claude-agent-sdk-*')" \
 && node --input-type=module -e 'await import("clanka/ClaudeAgent"); console.log("clanka/ClaudeAgent imports")'

FROM ${NODE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq openssh-client procps ripgrep sqlite3 tini unzip xz-utils \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=build /opt/chad/package.json /opt/chad/package.json
COPY --from=build /opt/chad/node_modules /opt/chad/node_modules
COPY --from=build /opt/chad/dist /opt/chad/dist
COPY --from=build /opt/chad/plugins /opt/chad/plugins
COPY --from=build /opt/chad/bin /opt/chad/bin
RUN ln -s /opt/chad/bin/chad.js /usr/local/bin/chad && install -d -o node -g node /data
# A login shell resets PATH from /etc/profile. This puts the volume's bin directories back, last, and only once.
RUN printf '%s\n' 'for d in /data/home/.npm-global/bin /data/home/.local/bin; do case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac; done; export PATH' > /etc/profile.d/chad.sh
# The volume's bin directories come last, so nothing installed there shadows the image's tools.
ENV CHAD_DATA=/data \
    HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    NPM_CONFIG_CACHE=/data/cache/npm \
    NPM_CONFIG_PREFIX=/data/home/.npm-global \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/data/home/.npm-global/bin:/data/home/.local/bin
USER node
WORKDIR /data
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s --start-interval=2s CMD ["chad", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/chad"]
CMD ["serve"]
```

## Entrypoint and the chad launcher

tini is a small init process. It runs as process 1, passes signals to the daemon and reaps orphaned processes, which Node as process 1 does not do. In the image run, SIGTERM reached the daemon's handler 35 to 51 ms after `docker stop` in three passes and 436 ms after in one.

- **IMG-13** The image sets `ENTRYPOINT ["tini", "--", "<absolute path to chad>"]` and `CMD ["serve"]`, both in exec form. The path to `chad` is absolute, so nothing on PATH can stand in for it.
- **IMG-14** The entrypoint uses plain tini and not `tini -g`. With `-g` the agent's processes and the MCP servers get SIGTERM before the daemon has drained.
- **IMG-15** The docs mention `--entrypoint bash` for a shell in a one-off run. "The docs", here and in every other rule of this part, are the user documentation that 00-overview.md defines.
- **IMG-16** (a) The `chad` executable is a few lines of plain JavaScript. With `serve` as the first argument it imports the daemon's entry point as separate files, not bundled. (b) For every other command it imports the CLI as one file bundled by esbuild with effect inside it. (c) The daemon never runs a bundled copy of effect.
- **IMG-17** `chad serve` sets `CHAD_SESSION=daemon` in its own environment when it starts, so stdio MCP servers and every other child of the daemon carry the marker. `CHAD_SESSION` is never an image `ENV`, so a `docker exec` shell has none (see 10-cli.md for what the marker does).
- **IMG-114** The daemon's signal handling, the exit timer of IMG-82, its exit codes and `CHAD_SESSION=daemon` live in one function, `runDaemon`, which `chad serve` calls (see 17-testing.md).

```js
#!/usr/bin/env node
// The whole launcher. `serve` loads the daemon from separate files, so its effect is the one in
// node_modules that plugins are given. Every other command loads one bundled file.
if (process.argv[2] === "serve") {
  await import("../dist/daemon.js") // adjusted: TIM-558, runDaemon sets CHAD_SESSION=daemon and the launcher does not
} else {
  await import("../dist/cli.bundle.js")
}
```

The bundled CLI file is 664 KB. `chad health` starts in 117 ms at the median as a bundle, against 353 ms not bundled.

## User, installs and PATH

- **IMG-18** The image runs as the `node` user, uid and gid 1000, and creates `/data` owned by it. Only uid 1000 is supported in v1.
- **IMG-19** The image sets `NPM_CONFIG_PREFIX=/data/home/.npm-global` and puts `/data/home/.npm-global/bin` and `/data/home/.local/bin` at the end of PATH, after the system directories.
- **IMG-20** npm globals, uv tools and binaries dropped in `~/.local/bin` persist on the volume when the container is replaced, and none of them can shadow a tool of the image. A `git`, `chad`, `node`, `npm` or `rg` placed in either volume bin directory is not the one that runs.
- **IMG-21** `/etc/profile.d/chad.sh` puts the two volume bin directories back on PATH in a login shell, last and once, because Debian's `/etc/profile` resets PATH.
- **IMG-22** The agent has no sudo and no apt. System packages need an image built `FROM` chad's.
- **IMG-23** uv and Node's `npx` are the runtimes for stdio MCP servers (see 12-skills-and-mcp.md).

## Environment variables

The image sets these variables to fixed values. `CHAD_DATA=/data` is from the build that was run, and the daemon's own default is the same path.

| Variable | Value in the image |
| --- | --- |
| `CHAD_DATA` | `/data` |
| `HOME` | `/data/home` |
| `XDG_CACHE_HOME` | `/data/cache` |
| `NPM_CONFIG_CACHE` | `/data/cache/npm` |
| `NPM_CONFIG_PREFIX` | `/data/home/.npm-global` |
| `PATH` | `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/data/home/.npm-global/bin:/data/home/.local/bin` |

- **IMG-24** The image sets `HOME`, `XDG_CACHE_HOME`, `NPM_CONFIG_CACHE`, `NPM_CONFIG_PREFIX` and PATH to the values in the table above.

The owner configures chad with the variables below and nothing else from the environment.

| Variable | What it does | Detail in |
| --- | --- | --- |
| `CHAD_DATA` | Names the data directory. The default is `/data`. | IMG-29, IMG-140 |
| `CHAD_SOCKET` | Moves the unix socket the CLI uses to reach the daemon. | IMG-30, IMG-63, 10-cli.md |
| `CHAD_SAFE_MODE` | `CHAD_SAFE_MODE=1` starts chad with nothing loaded from the repo. | 09-repo-and-recovery.md |
| `CHAD_MODEL` | The default model. A stored override set by `chad model` wins over it. | 05-model-and-login.md |
| `CHAD_OPENAI_API_URL` | The endpoint for `openai-compat` or the OpenAI API. | 05-model-and-login.md |
| `CHAD_OPENAI_API_KEY` | The key for that endpoint. | 05-model-and-login.md |
| `CHAD_LOG_LEVEL` | The daemon's log level, one of `all`, `trace`, `debug`, `info`, `warn`, `error`, `fatal` and `none`. The default is `info`. | IMG-115, 16-failures-logs-status.md |
| `TZ` | The default for the owner's timezone. | IMG-27 |
| any other name | A name that `mcp.json` or `chad.json` refers to as `${NAME}` and the secret store does not have. | 11-settings.md, 12-skills-and-mcp.md |

- **IMG-25** The table above is the whole list of environment variables that configure chad. Everything else is set through the CLI or a file in the repo.
- **IMG-26** Env does not supply a Discord token in v1.
- **IMG-27** `TZ` is the default for the owner's timezone, the timezone stored by `chad timezone` overrides it, and UTC applies when neither is set.
- **IMG-138** A `TZ` that does not name a valid zone counts as not set, so UTC applies unless a timezone is stored (see 10-cli.md for which zone names are valid).
- **IMG-28** A session's processes inherit the daemon's environment, with `CHAD_SESSION` set to the session id and `TZ` set to the stored owner timezone. The daemon sets no `TZ` on itself.
- **IMG-29** In the image the volume is mounted at `/data`. `CHAD_DATA` moves the daemon's files, the socket and the two links under `repo/`, and nothing else. That is what running chad outside the image needs, and what the process scenarios of 17-testing.md need to point `chad serve` at a temporary directory. It does not move `HOME`, the caches, the npm prefix or PATH, and the image's variables are not derived from it. Setting `CHAD_DATA` is not a supported way to move the volume inside the image.
- **IMG-140** The driver of the process scenarios sets `HOME`, the npm prefix (`NPM_CONFIG_PREFIX`) and the cache directory (`XDG_CACHE_HOME`, with `NPM_CONFIG_CACHE` under it) to paths inside its temporary directory, next to `CHAD_DATA`. `CHAD_DATA` moves none of them, so without this a `bash` command in a scripted turn would write into the developer's home (see 17-testing.md for the driver).
- **IMG-30** `CHAD_SOCKET` moves the unix socket away from `run/chad.sock`. It exists for a data path so deep that the socket path passes the platform's limit for a unix socket path, which is 107 bytes on Linux and 103 bytes on macOS.
- **IMG-115** `CHAD_LOG_LEVEL` takes `all`, `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `none`, in any case, and the default is `info`. Any other value logs a warning and uses `info`, and it never stops a boot. What the level filters is in 16-failures-logs-status.md.
- **IMG-116** No environment variable, flag or setting changes a duration that this part names. Each one is a default of the `Timings` service (see 17-testing.md).

The image's variables are not derived from `CHAD_DATA` because a `docker exec` shell would keep the image's values, and the owner and the agent would then install into different places. With `CHAD_DATA=/srv/chad` inside the image, an `npm install -g` landed on the container's own layer and was lost with the container. The warning in IMG-72 catches that mistake.

## The data volume

"One data volume" means one volume for chad's own state. The owner can mount other directories next to it. A session is one conversation with the owner, and each session has its own working directory on the volume.

```
/data/                          the mount point, WORKDIR
  db/
    chad.db                     SQLite, with its -wal and -shm files
    chad.db.before-migration    the copy of the database taken before a migration, latest only
                                (a file beside it records the version it was taken from, see 02-storage.md)
  repo/
    work/                       the git repo the agent edits
    versions/<tree>/            the exported tree that is live
    live                        symlink to that tree
    node_modules                symlink to the image's node_modules
    examples                    symlink to the bundled plugins' source in the chad package
    package.json                {"type": "module"}
  secrets/                      mode 0700, files 0600
    connections.json            chat connections
    secrets.json                named secrets
    auth/                       model logins
  state/
    safe-mode
    model
    timezone
    version
    notice-thread               where notices outside a turn go, one JSON line
    daemon.lock
    migrating                   present while an upgrade is unfinished (see 02-storage.md)
    db-unusable                 present while the unusable database notice stands (see 16-failures-logs-status.md)
    bundled-skills.json         a hash of each bundled skill (see 12-skills-and-mcp.md)
  run/                          mode 0700
    chad.sock                   mode 0600
    local.sock                  the local dev platform's socket, when one runs (see 17-testing.md)
  sessions/<session-id>/        a session's working directory
    inbox/                      files the owner sent
  home/                         HOME, shared by every session
    .npm-global/                npm globals
    .local/bin/                 uv tools and dropped binaries
  cache/                        XDG_CACHE_HOME
    npm/                        NPM_CONFIG_CACHE
  logs/
    chad.log                    JSON lines, the file being written
    chad.log.1                  the three rotated files
    chad.log.2
    chad.log.3
/mnt/<name>/                    extra mounts, outside the volume
```

- **IMG-31** The volume is mounted at `/data`. `WORKDIR` is `/data` and `HOME` is `/data/home`.
- **IMG-32** The volume holds `db/`, `repo/`, `secrets/`, `state/`, `run/`, `sessions/<session-id>/` and `home/` with the files shown in the tree above. What each file holds is in 02-storage.md, 09-repo-and-recovery.md and 10-cli.md.
- **IMG-33** `chad serve` starts on an empty volume. It creates the directories and the repo with a first commit, runs with no chat connection and logs that setup is needed.
- **IMG-34** Everything on the volume is owned by the daemon's user. `secrets/` is mode 0700 and its files are 0600. That is hygiene and no barrier to the agent, which runs as the same user.
- **IMG-122** chad sets each file it writes under `secrets/` to mode 0600 with a chmod after the write, as IMG-35 does for the socket.
- **IMG-123** chad never changes the process umask. A umask of 077 would also change the mode of every file that the agent's `bash` creates.
- **IMG-35** `run/` is a directory of mode 0700, set on every start. The socket is set to 0600 after `listen`, with no umask change.
- **IMG-36** A session's Agent starts in `sessions/<session-id>/`. `HOME` is `home/` on the volume and is shared by every session, for work that should outlast one (see 03-sessions-and-turns.md).
- **IMG-37** `cache/` holds what can be downloaded again. `XDG_CACHE_HOME=/data/cache` and `NPM_CONFIG_CACHE=/data/cache/npm` send the npm and uv caches there, and nothing is cached under `home/`.
- **IMG-38** The daemon logs to stdout and also writes JSON lines to `logs/chad.log`, so the agent can read why a plugin was skipped or a hook failed. When `chad.log` passes 10 MB it is renamed to `chad.log.1`, and `chad.log.1` to `chad.log.3` are kept, so `logs/` takes at most 40 MB. Only the daemon writes these files. The format of each sink, the logger, the rotation and `chad logs`, which reads the files, are in 16-failures-logs-status.md.
- **IMG-117** `state/notice-thread` holds one JSON line with the name of the connection and the thread that notices outside a turn go to. chad writes it by temp file and rename whenever that destination changes (see 02-storage.md for the line's shape and 16-failures-logs-status.md for the behaviour).
- **IMG-118** A turn's script source and output are logged, so they reach stdout and go wherever the container's logs are shipped (see 16-failures-logs-status.md).
- **IMG-39** `chad serve` writes `state/version` after its migrations. It records the chad version that last wrote the volume. An older `chad serve` that finds a newer version exits 1, and its exit message names the copy of the database taken before the migration, `db/chad.db.before-migration`. The migration records beside the copy the version that the copy was taken from. When that version is the refusing image's own, the message gives the steps that put the volume back for it, which are to delete `db/chad.db-wal` and `db/chad.db-shm`, to restore the copy and to put the older version back in `state/version`. Otherwise the message names the version that the copy belongs to and gives no steps. Restoring the copy alone leaves the newer `state/version` in place, so the older image would refuse again, and restoring it under an old write-ahead log corrupts the database. The rule for the message and for the record beside the copy is in 02-storage.md. By the time it exits, the daemon holds the lock and has touched nothing else on the volume but its log file (see IMG-127).
- **IMG-40** The first boot of a new image copies the database to `db/chad.db.before-migration` before anything migrates. Only the latest copy is kept, under that one name. Its use is rolling back on the volume it sits on. It is made with `node:sqlite`'s stepped online backup, so the daemon keeps answering pings while it runs.
- **IMG-124** How chad tells that a boot is the first on a new image, how the copy is written, and the file `state/migrating` that keeps a boot from replacing the copy while an upgrade is unfinished, are in 02-storage.md.
- **IMG-41** `chad backup` skips `cache/`, `logs/` and the copy of the database from IMG-40 (see 02-storage.md for what it takes).
- **IMG-42** (a) An extra mount sits at `/mnt/<name>`, which is `/mnt/vault` in the examples, and is mounted read-only when the owner wants it protected. (b) Extra mounts are outside the repo, so they get no commits and no revert, and backing them up is the owner's job. (c) The agent learns that a mount exists from the persona (see 14-self-edit-skill.md).

## The links under repo/ and what a plugin can import

A plugin is a TypeScript file in the repo that the daemon type-checks, bundles and loads (see 07-plugin-loading.md). The type-check and the agent's own tools find packages by walking up from `repo/work/` to `repo/node_modules`, which points into the image. `repo/examples` gives the agent the source of the plugins that ship with chad, to read as working examples.

- **IMG-43** At boot chad creates whatever is missing under `repo/`: `work/`, `versions/<tree>/`, the `live` symlink, the `node_modules` symlink and a `package.json` that says `"type": "module"`.
- **IMG-44** `repo/node_modules` is a symlink to the image's `node_modules`. chad makes it again at every boot, so it follows the image when the image's path changes.
- **IMG-45** `repo/examples` is a symlink to the directory of the bundled plugins' TypeScript source inside the chad package. chad makes it again at every boot, so after an image upgrade it shows the new image's source. Nothing loads from it.
- **IMG-46** At boot chad replaces a link at `repo/examples` or `repo/node_modules` without asking. Anything else at those paths is moved to `<name>.replaced-<timestamp>` and logged.
- **IMG-47** Both links sit above `work/` and outside git, so `git status` in `work/` never shows them and an apply never commits them.
- **IMG-48** uid 1000 cannot write through `repo/examples` into the image's files.
- **IMG-49** The image makes `chad` resolvable from `repo/node_modules` by a link from the chad package to itself (`node_modules/chad -> ..`), so `import { Plugin } from "chad"` passes the type-check. The package's `exports` lists `.`, `./Plugin`, `./Session` and `./Turns` and nothing else, so `import "chad/daemon"` fails the type-check.
- **IMG-50** A plugin can import `chad`, `effect` and Node's built-in modules, and those three are the promised list that is part of the plugin API. chad's other direct dependencies also resolve from `repo/node_modules`, and they are not promised (see 06-plugin-api.md).
- **IMG-51** The package that `import { Plugin } from "chad"` resolves to carries the bundled plugins' TypeScript source.
- **IMG-143** The name a boot moves something aside to under IMG-46 carries the boot's time in UTC, in ISO 8601 with each `:` and `.` turned into `-`, as in `node_modules.replaced-2026-11-16T06-28-57-056Z`. When that name is taken, by an earlier move in the same millisecond or by any other entry, a link to nothing included, the name gets `-1`, `-2` and so on, the first one that is free, so a move never replaces what is already there.
- **IMG-144** The examples under `repo/examples` import chad's modules as a repo plugin does, from `chad/Plugin`, `chad/Session` and `chad/Turns`. The image build writes them from the bundled plugins' source with each relative import of a chad module turned into that package import, so an example type-checks as it is written.

These paths exist in the image, and the `self-edit` skill names them:

```
/data/repo/node_modules/chad/dist/Plugin.d.ts
/data/repo/node_modules/chad/dist/Session.d.ts
/data/repo/node_modules/chad/dist/Turns.d.ts
/data/repo/node_modules/effect/AGENTS.md
/data/repo/node_modules/effect/ai-docs/src/
/data/repo/examples/cron/
/data/repo/examples/send-file.ts
/data/logs/chad.log
```

The `exports` field of chad's `package.json`:

```json
{
  "name": "chad",
  "type": "module",
  "bin": { "chad": "./bin/chad.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./Plugin": { "types": "./dist/Plugin.d.ts", "default": "./dist/Plugin.js" },
    "./Session": { "types": "./dist/Session.d.ts", "default": "./dist/Session.js" },
    "./Turns": { "types": "./dist/Turns.d.ts", "default": "./dist/Turns.js" }
  },
  "files": ["bin", "dist", "plugins"]
}
```

uid 1000 can replace either link itself. The next boot then applies IMG-46. The stand-in daemon wrote the timestamp as `YYYYMMDDTHHMMSS` in UTC.

## Pinned packages and the vendored effect tarballs

effect/chat is not released. It is installed from a snapshot of the effect pull request, published by pkg.pr.new at one commit. Every effect package has to come from that same commit, or the process holds two copies of effect. The tarballs are committed in the chad repo so that a build does not depend on pkg.pr.new keeping them. The seven tarballs are 12.8 MB together, and `effect.tgz` is 10.8 MB of that.

- **IMG-52** `effect` and every `@effect/*` package, the two OpenAI ones included, come from one snapshot of the effect pull request at one commit, through a pnpm catalog, with the tarballs committed under `vendor/` in the chad repo. A manifest under `vendor/` names the exact commit in full. The spec names only the floor of IMG-133, so a snapshot that moves changes the manifest and no rule.
- **IMG-133** The vendored snapshot is the `effect-chat` branch at commit `e1ae842` or a newer commit of that branch (see 00-overview.md for the pins). When a newer commit may be taken is stated in 17-testing.md.
- **IMG-134** If effect/chat ships in a release of effect before the first build slice, chad installs the released packages and the repo has no `vendor/` directory (see 00-overview.md).
- **IMG-53** Each dependency edge inside the snapshot that names a pkg.pr.new URL is redirected to its tarball by a pnpm `overrides` entry. The lockfile names no pkg.pr.new URL, and a clean `pnpm install --frozen-lockfile` passes with pkg.pr.new unreachable.
- **IMG-54** The pnpm 12 workspace sets `blockExoticSubdeps: false`, `enableGlobalVirtualStore: false`, `allowBuilds` for esbuild and `minimumReleaseAgeExclude: clanka@0.28.0`, with the version in it.
- **IMG-55** clanka is version 0.28.0 from npm, pinned by the lockfile. It is not vendored.
- **IMG-56** (a) CI fails when `node_modules` holds more than one `effect`. The check counts the copies under the `node_modules` of a clean install of the checkout, so it needs no image. (b) The image build repeats the count, as the Dockerfile above shows (see 07-plugin-loading.md).
- **IMG-57** The move to released versions of effect is one commit, which changes the catalog and the overrides and nothing else.
- **IMG-119** One script replaces the vendored tarballs as a set. A real upgrade uses it (see 17-testing.md).

pkg.pr.new is the only place a snapshot's packages are published, so the script of IMG-119 downloads from it. No install does (IMG-53).

The catalog below lists the seven packages of the build that ran, which had no test runner. IMG-52 covers every `@effect/*` package chad depends on, so one that is added later, such as the `@effect/vitest` that 17-testing.md names, comes from the same snapshot and gets its own tarball and catalog line.

`pnpm-workspace.yaml`, as built, with the clanka line moved to the pin. The build that ran used clanka 0.27.0 and the effect snapshot at commit `0b51fb176db86e796a914921b11c544eac2670af`, which is older than the floor of IMG-133.

```yaml
# effect and every @effect/* package come from one snapshot of the effect PR, as tarballs under vendor/.
# A manifest under vendor/ names the commit. # adjusted: TIM-559, the build that ran named the file vendor/SHA
# Moving to released versions is this catalog and the overrides, nothing else.
catalog:
  effect: file:vendor/effect.tgz
  "@effect/ai-openai": file:vendor/effect-ai-openai.tgz
  "@effect/ai-openai-compat": file:vendor/effect-ai-openai-compat.tgz
  "@effect/chat-discord": file:vendor/effect-chat-discord.tgz
  "@effect/platform-node": file:vendor/effect-platform-node.tgz
  "@effect/platform-node-shared": file:vendor/effect-platform-node-shared.tgz
  "@effect/sql-sqlite-node": file:vendor/effect-sql-sqlite-node.tgz

# The snapshot's @effect/platform-node names @effect/platform-node-shared by a pkg.pr.new URL.
# Each such edge is redirected to the tarball here.
overrides:
  effect: "catalog:"
  "@effect/platform-node-shared": "catalog:"

blockExoticSubdeps: false

# pnpm 12 links node_modules into a store outside the project by default. The image copies
# /opt/chad from the build stage, so the packages have to sit inside it.
enableGlobalVirtualStore: false

# esbuild's postinstall only checks its binary. Without this entry pnpm 12 exits 1.
allowBuilds:
  esbuild: true

# The Claude SDK's JavaScript stays because clanka imports it. Its platform binary (349 MB) does not.
ignoredOptionalDependencies:
  - "@anthropic-ai/claude-agent-sdk-linux-x64"
  - "@anthropic-ai/claude-agent-sdk-linux-arm64"
  - "@anthropic-ai/claude-agent-sdk-linux-x64-musl"
  - "@anthropic-ai/claude-agent-sdk-linux-arm64-musl"
  - "@anthropic-ai/claude-agent-sdk-darwin-x64"
  - "@anthropic-ai/claude-agent-sdk-darwin-arm64"
  - "@anthropic-ai/claude-agent-sdk-win32-x64"
  - "@anthropic-ai/claude-agent-sdk-win32-arm64"

minimumReleaseAgeExclude:
  - clanka@0.28.0 # adjusted: TIM-559, the pin moved from 0.27.0
```

The dependencies of the package that was built, which are the stand-in's and not the final list of chad's direct dependencies. The clanka line shows the pin, and the build ran with 0.27.0:

```json
{
  "dependencies": {
    "@effect/ai-openai": "catalog:",
    "@effect/ai-openai-compat": "catalog:",
    "@effect/chat-discord": "catalog:",
    "@effect/platform-node": "catalog:",
    "@effect/sql-sqlite-node": "catalog:",
    "effect": "catalog:",
    "clanka": "0.28.0",
    "dfx": "^1.1.1",
    "esbuild": "0.28.2",
    "typescript": "7.0.2",
    "@types/node": "^26.0.0"
  }
}
```

## Boot checks

`chad serve` boots in the order below. A step that is not listed has no decided position.

1. The start-up check of IMG-58 and the filesystem read of IMG-70 run. No lock is held and nothing is written to the volume, the log file included, so a boot refused here writes nothing.
2. The daemon takes the lock. A daemon that is refused exits before it touches anything else, the log file included.
3. The daemon reads `state/version` and exits when it is newer than this chad (see IMG-39).
4. Withdrawn. The later steps keep their numbers.
5. The daemon checks the socket path, removes a stale socket file and listens.
6. The shard count guard of IMG-64 runs.
7. On the first boot of a new image the database is copied (see IMG-40). Then the migrations run.
8. `state/version` is written.
9. Plugins, MCP servers and chat connections load.

The log events of a boot are `boot.started` once `chad serve` holds the lock, `boot.ready` when the boot has finished, `boot.refused` for a boot that was refused, `boot.setup-needed` for IMG-33, `boot.moved-aside` for IMG-46, `boot.filesystem` for IMG-70 and IMG-72, `boot.log-level-unknown` for IMG-115, `database.migrated` when step 7 migrated the database and `database.unusable` for IMG-66. The rule for each, and the full table of event names, are in 16-failures-logs-status.md.

In the image run the socket listened 0.8 to 1.3 s after the container started, and importing clanka was 0.76 s of that. `chad status` answered 1.2 s after `docker run`, and Docker marked the container healthy at 2.7 s.

- **IMG-125** `chad serve` runs the steps of a boot in the order of the numbered list above.
- **IMG-126** The filesystem read of IMG-70 runs with the start-up check of IMG-58, before the lock is taken, and neither writes anything to the volume. A boot that is refused before it holds the lock writes its `boot.refused` line, and any warning from these two checks, to stdout only. A boot that goes on writes the warning of IMG-70 to stdout at once and to `logs/chad.log` only once it holds the lock (see 16-failures-logs-status.md for the two sinks and this exception).
- **IMG-127** The check for a newer `state/version` runs after the lock is taken and before the socket is touched or the database is opened. It runs under the lock so that a `chad restore` that finishes between an unlocked read and the lock cannot slip a newer volume past it. Taking the lock writes no data (see 10-cli.md), so a boot refused here has written nothing on the volume but its lines in `logs/chad.log`, which it writes because it holds the lock.
- **IMG-58** `chad serve` checks at start that it can write the volume and that `repo/`, when it exists, is owned by its own uid. An empty volume has no `repo/` and passes (see IMG-33). When either fails it exits 1 with a message that names its uid and the owner. The check covers `repo/` because git refuses a repository owned by another uid.
- **IMG-59** The daemon takes a SQLite lock on `state/daemon.lock` at boot and holds it for its whole life. A second `chad serve` on the same volume fails to take it and exits (see 10-cli.md for the mechanism and the CLI's use of the same lock).
- **IMG-60** A daemon that is refused the lock exits 1 before it touches anything else, including a socket file and the log file. Its `boot.refused` line goes to stdout only (see IMG-126).
- **IMG-61** The daemon keeps the lock's handle until the process exits and closes it only then. The test suite has a check that forces garbage collections and then tries the lock.
- **IMG-62** The daemon listens on the socket once it holds the lock and has passed the check for a newer `state/version`. That is before it opens, copies or migrates the database and before it loads plugins, MCP servers and connections. `chad status` answers during boot and says which phase the boot is in, and `chad health` passes during boot.
- **IMG-128** `chad status` names the phase of the boot as one of `starting`, `listening`, `database`, `loading`, `ready` and `stopping`.
- **IMG-141** The phases of IMG-128 cover the boot list above as the stand-in daemon used them. The phase is `starting` until the socket listens, which no client sees, `listening` for steps 5 and 6, `database` for steps 7 and 8, `loading` for step 9, `ready` once step 9 is done, and `stopping` from the signal that stops the daemon.
- **IMG-142** The daemon opens `logs/chad.log` straight after it has taken the lock, and makes `logs/` then when it is missing. A boot that is refused at a later step therefore leaves its lines in the file.
- **IMG-63** The socket error has two forms. A socket path longer than the platform's limit is refused with a message that gives the length and the limit and names `CHAD_SOCKET` as the fix. A filesystem that cannot hold a socket is named as unsupported. The limit is the one of the platform chad runs on, which is 107 bytes on Linux and 103 bytes on macOS, and never a fixed 107.
- **IMG-64** `chad serve` runs effect cluster's `SingleRunner` with `shardsPerGroup: 1`, from the first release. The count is kept in a database row. A daemon that finds another count refuses to start and names both numbers (see 02-storage.md and 03-sessions-and-turns.md).
- **IMG-65** The shard count guard runs before the database copy and the migrations, so a boot it refuses leaves the database as it was. That boot holds the lock, so its log lines go to both sinks.
- **IMG-129** A boot that the shard count guard refuses exits 1.
- **IMG-66** With a database that cannot be opened or migrated for any reason other than a newer `state/version`, chad stays up without sessions, sends the owner one notice and answers each owner message with the error. The notice is not sent again at a later boot while the database stays unusable, which the file `state/db-unusable` records (see 02-storage.md and 16-failures-logs-status.md).
- **IMG-67** A free space check runs at boot and then hourly. It sends the `disk-low` notice when the volume has less than 1 GB free (see 02-storage.md and 16-failures-logs-status.md).

The stand-in daemon held `starting` until its socket listened, set `listening` then, `database` before it opened the database, `loading` before it made the links and loaded, `ready` after that, and `stopping` in its SIGTERM handler. It had no check for a newer `state/version`, no shard count guard and no migrations, so it does not say which phase those steps belong to (see IMG-G20).

The lock rule in IMG-61 comes from a failure. The lock is a SQLite write transaction held open. When nothing referred to its handle after boot, a garbage collection closed it, and a second daemon ran on the same volume for 30 minutes while both reported healthy.

The messages of the stand-in daemon for IMG-58, with `/data` as the data directory and 1000 as the uid:

```
chad serve: /data does not exist. Mount the data volume there or set CHAD_DATA.
chad serve: cannot write /data. chad runs as uid 1000, gid 1000 and /data is owned by uid <uid>, gid <gid>, mode <mode>. Give the volume to uid 1000, for example: chown -R 1000:1000 <volume>
chad serve: /data/repo is owned by uid <uid>, gid <gid>, mode <mode> and chad runs as uid 1000. git refuses a repository owned by another user. Give it to uid 1000: chown -R 1000:1000 /data/repo
chad serve: another chad serve holds the lock on /data.
```

The messages for IMG-63 and IMG-64. The stand-in daemon ran on Linux only and printed 107 where the first message has `<limit>`:

```
chad serve: the socket path <path> is <n> bytes and a unix socket path holds <limit>. Set CHAD_SOCKET to a shorter path, for example /tmp/chad.sock.
chad serve: cannot create the socket <path> (<error code>). <directory> is on <filesystem type>, which cannot hold a unix socket. chad needs a local filesystem under /data.
chad serve: this database was made with <stored> shards and this chad uses <now>. Messages stored under the old count would never be delivered, so chad will not start.
```

The start-up check refuses a named volume first written by root, a host directory Docker created for the mount, a directory owned by uid 1001 and a run as uid 2000. A fresh named volume mounted anywhere but `/data` is owned by root and is refused in the same way, which is the check working. A fresh named volume at `/data` and a host directory owned by uid 1000 both boot.

## Filesystem requirement and warnings

The database runs in SQLite's write-ahead log mode and the daemon lock is a SQLite lock. Neither is safe on a network filesystem.

- **IMG-68** The volume has to be a local filesystem. An NFS-backed volume is unsupported.
- **IMG-69** Supported volumes are a host directory, a local-path volume, a cloud block volume and Longhorn RWO. Longhorn RWX and CephFS are unsupported, like NFS.
- **IMG-70** `chad serve` reads the type of the filesystem under the data directory and warns, at boot in the log and in `chad status`, when it is NFS, CephFS, SMB, FUSE, the container's own layer or tmpfs. It warns and does not refuse.
- **IMG-71** The check follows `CHAD_DATA` to the mount that holds it.
- **IMG-72** The check also runs on `HOME`, `NPM_CONFIG_PREFIX` and `XDG_CACHE_HOME`, and warns for each one that is on the container's own layer or on tmpfs.

The warnings of the stand-in daemon:

```
/data is on <type>. chad needs a local filesystem: SQLite's lock and write-ahead log are not safe on a network or FUSE filesystem.
/data is on the container's own filesystem, not on a volume. Everything chad writes is lost when the container is removed. Mount a volume at /data.
/data is on <tmpfs or ramfs>, which is memory. Everything chad writes is lost when the container stops.
<NAME>=<value> is on <the container's own filesystem, or tmpfs>, not on the volume at /data. What is installed there is lost with the container. In the chad image the volume is mounted at /data.
```

The stand-in treated these mount types as network or FUSE: `nfs`, `nfs4`, `ceph`, `cifs`, `smb3`, `smbfs`, `9p`, `glusterfs`, `lustre`, `fuse` and `fuse.*`. It read them from `/proc/self/mountinfo`. Outside a container the check on `HOME` and the other two gives no warning.

chad does not run on sshfs at all. The daemon cannot create its socket there, and with `CHAD_SOCKET=/tmp/chad.sock` it fails on the next step, making the links. On NFS just after the NFS server restarted, the daemon blocked for 58 to 102 s before it listened.

## Health probe

`chad health` is the liveness probe. A frozen daemon is not a crash, so only a probe that restarts the container gets chad back.

- **IMG-74** `chad health` exits 0 only when the lock is held and the daemon answers one ping inside 2 seconds. It prints one line and checks nothing else.
- **IMG-75** `chad health` tests the lock before the ping. With the lock free it exits 4, even when a daemon still answers. With the lock held and no answer it exits 4.
- **IMG-76** On Kubernetes the liveness probe runs `chad health` every 30 seconds with a 5 second timeout and 3 failures.
- **IMG-77** On Kubernetes a startup probe runs the same command every 2 seconds with 30 failures.
- **IMG-78** There is no readiness probe.
- **IMG-79** The image carries a `HEALTHCHECK` with the same numbers: `--interval=30s --timeout=5s --retries=3 --start-period=60s --start-interval=2s`. This rule is about the line in the Dockerfile, and reading the built image's configuration tests it. What the command does is IMG-74 and IMG-75.
- **IMG-80** Under plain Docker nothing restarts a frozen container, and the docs say so. v1 has no watchdog.

In the image run Docker reported a daemon stopped with SIGSTOP as unhealthy 97 s after the freeze and restarted nothing, with `--restart unless-stopped` set.

## Stopping

A graceful stop starts when the daemon gets SIGTERM, which `docker stop` and Kubernetes both send. Docker's default stop timeout is 10 seconds and Kubernetes's default grace period is 30, after which the container is killed. An image cannot set the timeout, so the examples set it.

- **IMG-81** On SIGTERM the daemon stops taking new turns.
- **IMG-82** The SIGTERM handler starts a timer. At 60 seconds from SIGTERM the timer exits the process with code 1 and logs what was still open, as the event `stop.cut`. The 60 seconds is a duration of the `Timings` service (see IMG-116). The timer runs on the daemon's event loop, so a blocked event loop stops it, and the 90 second grace period of IMG-87 stays the backstop.
- **IMG-139** chad writes the `stop.cut` line synchronously to both sinks, stdout and `logs/chad.log`, before the timer of IMG-82 exits the process. It is the one line that explains a forced exit, and a write left pending would be lost with the process.
- **IMG-83** The stop runs in the order of the table below. Only the 15 seconds for requests in flight is a duration. The other limits are points in time measured from SIGTERM.

| Order | Step | Limit |
| --- | --- | --- |
| 1 | Abandon a plugin swap or an MCP layer rebuild that is in progress (see 08-apply-and-swap.md and 12-skills-and-mcp.md). | None of its own. Abandoning a rebuild measured 2.0 s. |
| 2 | Wait for requests in flight. A turn that ends in this time finishes. A longer one is cut and resumed on the next start, and a cut by a graceful stop does not count toward the two kills after which chad gives up on a turn (see 03-sessions-and-turns.md). | 15 seconds, which is cluster's `entityTerminationTimeout` |
| 3 | Run the hooks queued off the reply path, each inside its own budget (see 06-plugin-api.md). | Until 50 seconds from SIGTERM |
| 4 | Close the plugins' scopes, then the MCP layer. | Until 60 seconds from SIGTERM |

- **IMG-84** The stop closes plugin scopes before the MCP layer, so the deadline only ever cuts MCP servers.
- **IMG-85** (a) A stop the daemon finished exits 0. (b) A stop cut by chad's own deadline exits 1, and its log line, the event `stop.cut`, names what was still open.
- **IMG-86** The daemon logs what a stop dropped, as the event `stop.dropped`. Hooks dropped in a stop and a stop cut by the deadline are log lines only, and no notice is sent for them (see 16-failures-logs-status.md).
- **IMG-87** The examples set a 90 second grace period.
- **IMG-120** The log writer flushes on every exit path chad controls (see 16-failures-logs-status.md).
- **IMG-131** A stop gives a nightly prune that is in progress no wait of its own (see 02-storage.md for the prune and for how its next run finishes one that an exit cut).

A stop also writes `stop.started` when the SIGTERM handler runs and `stop.ended`, with the duration, when it finishes inside the deadline. The rules for both, and the full table of event names, are in 16-failures-logs-status.md.

In the image run an idle daemon exited 32 to 38 ms after SIGTERM with code 0. With a turn running it exited at 15.0 s. A timer on hold for an unloaded plugin is a request in flight, so a stop then takes the full 15 seconds. clanka closes stdio MCP servers one after another, and a server that ignores its stdin closing and SIGTERM takes 4 s. A turn and three such servers exited 0 at 27.1 s. A turn and twelve were cut by the deadline at 60.0 s with code 1, and the log line named the servers. Without the timer of IMG-82, a turn that ignores interruption kept the daemon alive until Docker's kill at 90 s. That turn was a mode of the stand-in daemon, made for this run. No rule gives chad such a turn, and in chad only the close of the MCP layer can reach the deadline (IMG-84).

## Exit codes of chad serve

- **IMG-88** `chad serve` exits with the codes in the table below.

| Code | When |
| --- | --- |
| 0 | A stop that the daemon finished. |
| 1 | A stop cut by the 60 second deadline of IMG-82. |
| 1 | The start-up check of IMG-58 failed. |
| 1 | Another daemon holds the lock. |
| 1 | The socket could not be created (IMG-63). |
| 1 | `state/version` is newer than this chad (IMG-39). |
| 1 | The shard count guard refused the boot (IMG-129). |

The exit codes of every other command are in 10-cli.md. A container killed by Docker or Kubernetes at the end of the grace period reports 137.

## Unclean boots and the boot counter

chad keeps no boot counter, and safe mode never starts by itself (see 09-repo-and-recovery.md).

## Running chad and first setup

- **IMG-93** The docs show one path to a running chad. The owner starts the container and then runs `docker exec -it chad chad setup`, or `kubectl exec -it deploy/chad -- chad setup` on Kubernetes.
- **IMG-94** A one-off run of `chad setup` against the volume before the first start also works (see 10-cli.md for the wizard and its flags).
- **IMG-95** The examples pin a version tag of the image.
- **IMG-96** `chad restore` gets its own example, with the container stopped (see 02-storage.md).
- **IMG-97** A one-off run of a different chad version against a live daemon is refused by the version check for every command except `status` and `health` (see 10-cli.md).

## Containers next to chad

asphodel is the memory daemon that the asphodel plugin talks to over http (see 18-asphodel-plugin.md). It runs as its own container next to chad.

## The Kubernetes example

- **IMG-102** The Kubernetes example is a Deployment with one replica and `strategy: Recreate`. A rollout has to stop the old pod before the new one starts, because a second daemon on the same volume is refused the lock.
- **IMG-103** The Deployment has one ReadWriteOnce (RWO) claim for `/data`, `runAsUser: 1000`, `runAsNonRoot: true`, `fsGroup: 1000` with `OnRootMismatch`, `allowPrivilegeEscalation: false`, all capabilities dropped, `seccompProfile: RuntimeDefault` and no service account token.
- **IMG-104** `fsGroup` has no effect on a local-path volume, which is a host directory the provisioner creates with mode 0777. It stays in the example for other volume types, and on local-path the start-up check of IMG-58 is the guard.
- **IMG-105** The Deployment carries the liveness probe of IMG-76, the startup probe of IMG-77 and a 90 second termination grace period.
- **IMG-106** On Kubernetes asphodel is a native sidecar in chad's pod, which is an init container with `restartPolicy: Always`. The plugin's `url` setting is `http://127.0.0.1:7720`, and the token comes from one Secret in both containers. A `${NAME}` that the secret store does not have resolves from process env, which is how a Kubernetes Secret supplies a plugin's token.
- **IMG-107** The Deployment mounts a vault claim at `/mnt/vault`.
- **IMG-108** The Kubernetes backup is a CronJob of the chad image that mounts the data claim and a destination and runs `chad backup /backup/chad-<date>.tar`. It has `concurrencyPolicy: Forbid` and no required pod affinity, so a backup works while chad's pod is down. Its image tag comes from the same variable as the Deployment's.
- **IMG-109** asphodel's volume is not in `chad backup`, so both examples back it up next to chad's.
- **IMG-110** The examples do not make the root filesystem read-only and set no resource requests or limits.

The fragment below renders the decided fields. The names `chad`, `data` and `vault` are placeholders, and the asphodel sidecar, the claims and the CronJob are left out because their names, images, sizes and schedule are not decided.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chad
spec:
  replicas: 1
  strategy:
    type: Recreate
  template:
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 90
      securityContext:
        runAsUser: 1000
        runAsNonRoot: true
        fsGroup: 1000
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: chad
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          livenessProbe:
            exec:
              command: ["chad", "health"]
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
          startupProbe:
            exec:
              command: ["chad", "health"]
            periodSeconds: 2
            failureThreshold: 30
          volumeMounts:
            - name: data
              mountPath: /data
            - name: vault
              mountPath: /mnt/vault
```

## Gaps

- **IMG-G10** [builder] Which of Renovate and Dependabot the chad repo uses. Renovate needs Tim to install an app or supply a token, which is on no list of what Tim provides, and Dependabot needs nothing from him. Whether Dependabot follows a digest held in an `ARG`, as the Dockerfile above holds it, was not checked. Recommended: Dependabot, with the digest written on the `FROM` lines if the `ARG` hides it from the bump. TIM-541 item 1.
- **IMG-G12** [builder] The format of the timestamp in `<name>.replaced-<timestamp>`. The stand-in wrote `YYYYMMDDTHHMMSS` in UTC. TIM-553 item 9.
- **IMG-G13** [builder] The timeout of the Kubernetes startup probe. The liveness probe has 5 seconds and the startup probe has none stated. TIM-541 item 24.
- **IMG-G14** [builder] The full text of the Kubernetes manifests and the CronJob, which needs resource names, the asphodel image, claim sizes, the Secret's name, and the backup schedule and destination. TIM-541 items 27 to 29 fix their contents and not their text.
- **IMG-G15** [builder] Resource requests and limits. Nothing was measured, and IMG-110 leaves them out of the examples. TIM-541.
- **IMG-G16** [tim] The filesystem under the local-path directory on Tim's node, which `stat -f -c %T /var/local-path-provisioner` answers. It is a measurement and not a decision, so nobody can answer it for him. The lock and the write-ahead log were run on ext4 and tmpfs only, and the one run of the Kubernetes checks on his k3s node records it (see 17-testing.md). Nothing in the build waits for it. TIM-541 and TIM-553.
- **IMG-G18** [builder] The exact versions of uv, pnpm, TypeScript and esbuild. The prototype used uv 0.13.8, pnpm 12.18.0, TypeScript 7.0.2 and esbuild 0.28.2. TIM-541 item 2 and TIM-553.
- **IMG-G20** [builder] Which steps of the boot list each phase name of IMG-128 covers. The daemon does not listen before step 5, so it can never answer `starting`, and 10-cli.md has the CLI say "starting or frozen" for a held lock with no socket. Recommended: the stand-in's use, which is `starting` until the socket listens and seen by no client, `listening` for steps 5 and 6, `database` for steps 7 and 8, `loading` for step 9, `ready` after it and `stopping` from SIGTERM. TIM-550 item 7, and TIM-559 cold read, cli reader.
- **IMG-G21** [builder] Where in the boot list the daemon opens `logs/chad.log`. It cannot be before the lock (IMG-126), and the list gives it no step. The same question for the directories an empty volume lacks is a gap of 02-storage.md, which recommends `state/` when the lock is taken and the others once step 3 has passed. Recommended: the file is opened straight after the lock is taken, and `logs/` is made with it when missing, so that a boot refused at step 3 still leaves its lines in the file. TIM-541 item 13, and TIM-559 cold read, harness reader.
- **IMG-G22** [builder] What "stops taking new turns" in IMG-81 does with an owner message that arrives, or a steering message whose turn ends, during the 15 second wait of IMG-83. The question and its recommendation are a gap of 03-sessions-and-turns.md, which owns the turn and its redelivery. TIM-541 item 25, and TIM-559 cold read, kills reader.

## Provenance

Where a row's support is "run", it ran in the image on Docker CE 29.9.3 unless the "Source" column gives another place or a limit. Nothing ran on Kubernetes or under Compose.

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| IMG-1 | TIM-541 item 1, TIM-538 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-2 | TIM-541 item 1 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-3 | TIM-541 item 2 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-4 | TIM-541 item 2 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-5 | TIM-541 item 2, TIM-538 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-6 | TIM-541 item 3, TIM-535 as changed by TIM-541, TIM-559 cold read | Architect (Tim has not read) | run | TIM-541 | `rule` | `harness` |
| IMG-7 | TIM-541 item 3 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-8 | TIM-541 item 4, TIM-546 item 1, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-9 | TIM-541 item 6, amended by Tim's ruling that the image is amd64 only, chat 2026-11-15 | Architect (Tim has not read) | run |  | `rule` | `image` |
| IMG-10 | TIM-541 item 6, TIM-542 item 2, TIM-553 item 10 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-11 | TIM-549 item 22 (comment on TIM-541), TIM-553, TIM-559 cold read | Architect (Tim has not read) | run |  | `rule` | `loader` |
| IMG-12 | TIM-549 item 21 and its follow-up (comments on TIM-541), amended by TIM-557 item 43 and TIM-558 item 32 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| IMG-13 | TIM-541 item 5 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-14 | TIM-541 item 5 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-15 | TIM-541 item 5, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-16 | TIM-550 item 12, TIM-553 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-17 | TIM-550 item 3, TIM-553 | Architect (Tim has not read) | run | TIM-550 | `rule` | `cli` |
| IMG-18 | TIM-541 item 7 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-19 | TIM-541 item 9 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-20 | TIM-541 item 9 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-21 | TIM-553 item 12, amending TIM-541 item 9 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-22 | TIM-541 item 9 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-23 | TIM-541 (passed on), TIM-537 follow-up | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| IMG-24 | TIM-541 items 9, 10 and 12 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-25 | TIM-541 item 18, TIM-534 item 6, TIM-535, TIM-548 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| IMG-26 | TIM-542 item 34 | Tim | not run |  | `rule` | `cli` |
| IMG-27 | TIM-542 item 16 | Tim | not run |  | `rule` | `settings` |
| IMG-28 | TIM-541 item 19, TIM-542 item 29, TIM-553 item 13 | Architect (Tim has not read) | run | TIM-541, TIM-553 | `rule` | `settings` |
| IMG-29 | TIM-541 item 10, TIM-553 question 2, TIM-559 main session ruling on Q4, TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | run |  | `rule` | `harness` |
| IMG-30 | TIM-542 item 2, TIM-553 question 3, TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | run | TIM-553, TIM-559 | `rule` | `cli` |
| IMG-31 | TIM-541 item 10 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-32 | TIM-536 item 12, TIM-538 item 8, TIM-542, TIM-541 item 11 | Architect (Tim has not read) | read | TIM-541, TIM-557, TIM-558, TIM-559 | `rule` | `backup` |
| IMG-33 | TIM-542 item 32 | Tim | not run |  | `rule` | `apply` |
| IMG-34 | TIM-536 item 12 | Tim | not run |  | `rule` | `cli` |
| IMG-35 | TIM-550 item 6, TIM-541 item 11 (support: TIM-550 prototype) | Architect (Tim has not read) | run |  | `rule` | `cli` |
| IMG-36 | TIM-536 item 10 | Tim | read |  | `rule` | `turns` |
| IMG-37 | TIM-541 items 11 and 12 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-38 | TIM-541 item 13, amended by TIM-557 items 1, 10 and 11 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| IMG-39 | TIM-541 item 14, TIM-557 item 35, amended by TIM-559 rulings on IMG-G3 and IMG-G5 and by TIM-559 round 3 on IMG-G19 and STO-G28, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-541, TIM-557, TIM-559 | `rule` | `backup` |
| IMG-40 | TIM-536 item 13, TIM-541 item 15, amended by TIM-559 ruling on IMG-G3 | Architect (Tim has not read) | not run | TIM-541, TIM-559 | `rule` | `backup` |
| IMG-41 | TIM-541 item 12 | Architect (Tim has not read) | not run | TIM-541 | `rule` | `backup` |
| IMG-42 | TIM-534 item 10, TIM-541 item 16 | Architect (Tim has not read) | not run | TIM-541 | `rule` | `image` |
| IMG-43 | TIM-538 items 6 and 8 (support: TIM-538 prototype, not in Docker) | Tim | run |  | `rule` | `apply` |
| IMG-44 | TIM-538 item 8, TIM-553 item 9 | Architect (Tim has not read) | run | TIM-553 | `rule` | `loader` |
| IMG-45 | TIM-549 follow-up "repo/examples" (comment on TIM-541) | Tim | run |  | `rule` | `loader` |
| IMG-46 | TIM-553 item 9 | Architect (Tim has not read) | run |  | `rule` | `loader` |
| IMG-47 | TIM-538 item 8, TIM-549 follow-up, TIM-553 | Tim | run |  | `rule` | `apply` |
| IMG-48 | TIM-553 | Architect (Tim has not read) | run |  | `rule` | `loader` |
| IMG-49 | TIM-541 item 22, TIM-553 item 3 | Architect (Tim has not read) | run | TIM-541, TIM-553 | `rule` | `loader` |
| IMG-50 | TIM-541 item 22, amended by TIM-559 ruling on API-G12 | Architect (Tim has not read) | not run | TIM-541, TIM-559 | `rule` | `loader` |
| IMG-51 | TIM-549 item 4 (comment on TIM-541), TIM-553 | Architect (Tim has not read) | run |  | `rule` | `loader` |
| IMG-52 | charting fact, TIM-541 item 21, TIM-553 item 1, amended by TIM-559 main session ruling on Q8 (support: the vendoring ran at snapshot 0b51fb1, with the manifest named vendor/SHA), TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| IMG-53 | TIM-553 item 1 | Architect (Tim has not read) | run |  | `rule` | `repo` |
| IMG-54 | TIM-541 item 21, TIM-553 item 2, amended by TIM-559 ruling on OV-G1 (support: the settings ran with clanka@0.27.0) | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| IMG-55 | TIM-541 item 21, amended by TIM-559 ruling on OV-G1 and main session ruling on Q8 (support: Architect checked the published 0.28.0) | Architect (Tim has not read) | read |  | `rule` | `repo` |
| IMG-56 | TIM-541 item 21, TIM-559 cold read | Architect (Tim has not read) | run |  | `rule` | `repo` |
| IMG-57 | TIM-541 item 21 | Architect (Tim has not read) | not run |  | `definition` | - |
| IMG-58 | TIM-541 item 8, TIM-553, TIM-559 cold read | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-59 | TIM-536 item 18, TIM-542 item 3 | Tim | run |  | `rule` | `cli` |
| IMG-60 | TIM-550 item 8, TIM-559 cold read | Architect (Tim has not read) | run |  | `rule` | `cli` |
| IMG-61 | TIM-553 item 5 | Architect (Tim has not read) | run |  | `rule` | `kills` |
| IMG-62 | TIM-550 item 7, TIM-541 round 1 answer 13, amended by TIM-559 ruling on IMG-G5 (support: listening before the database ran, with the counter and no version check before it), amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read) | not run | TIM-550, TIM-559 | `rule` | `cli` |
| IMG-63 | TIM-550 item 6, TIM-553 item 11, TIM-559 round 2 R5 (support: the 107 byte limit ran on Linux, the macOS limit did not run); answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `rule` | `cli` |
| IMG-64 | TIM-553 item 4 (support: TIM-543 prototype, not in the image) | Architect (Tim has not read) | run | TIM-553 | `rule` | `harness` |
| IMG-65 | TIM-553 item 4, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-66 | TIM-536 item 14, amended by TIM-557 item 35 and by TIM-559 ruling on FAIL-G20 | Architect (Tim has not read) | not run | TIM-541, TIM-557, TIM-559 | `rule` | `failures` |
| IMG-67 | TIM-536 item 16, amended by TIM-557 item 31, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| IMG-68 | TIM-536 item 4 | Tim | read |  | `definition` | - |
| IMG-69 | TIM-541 item 17 | Architect (Tim has not read) | not run |  | `definition` | - |
| IMG-70 | TIM-541 item 17, TIM-553 item 10 (support: NFS, the container's layer and tmpfs only) | Architect (Tim has not read) | run |  | `rule` | `cli` |
| IMG-71 | TIM-553 item 10 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| IMG-72 | TIM-553 item 10 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| IMG-74 | TIM-542 item 20 | Tim | run |  | `rule` | `cli` |
| IMG-75 | TIM-553 item 6, TIM-550 item 7, TIM-542 item 27 | Architect (Tim has not read) | not run | TIM-550, TIM-553 | `rule` | `cli` |
| IMG-76 | TIM-541 item 24 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-77 | TIM-541 item 24 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-78 | TIM-541 item 24 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-79 | TIM-541 item 24, TIM-559 cold read | Architect (Tim has not read) | run |  | `rule` | `harness` |
| IMG-80 | TIM-541 item 24, amended by Tim's ruling that chad has no Compose example, chat 2026-11-15 | Architect (Tim has not read) | run |  | `rule` | `image` |
| IMG-81 | TIM-541 items 25 and 26, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-541 | `rule` | `apply` |
| IMG-82 | TIM-541 item 25, TIM-553 question 1, TIM-559 main session ruling on Q4, TIM-559 round 2 R5 (support: the timer and the exit at 60.0 s ran in the image, the blocked event loop did not run); answered for Tim by Jarvis, chat 2026-11-15, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | run |  | `rule` | `skills-mcp` |
| IMG-83 | TIM-541 item 25, TIM-543, TIM-547 item 15, TIM-553 question 1, TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `rule` | `skills-mcp` |
| IMG-84 | TIM-553 item 8 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| IMG-85 | TIM-553 item 7, TIM-559 round 2 R4 for the event name | Architect (Tim has not read) | run |  | `rule` | `kills` |
| IMG-86 | TIM-541 item 25, TIM-557 item 41, TIM-559 round 2 R4 for the event name | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| IMG-87 | TIM-541 item 25 | Architect (Tim has not read) | run |  | `rule` | `image` |
| IMG-88 | TIM-553 item 7, TIM-550 item 8, TIM-541 items 8 and 14, amended by TIM-559 ruling on IMG-G7 (support: the stop, start-up check, lock and socket rows ran in the image, the newer state/version row did not run) | Architect (Tim has not read) | not run | TIM-541, TIM-557 | `rule` | `kills` |
| IMG-93 | TIM-541 item 20, TIM-542 item 32 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-94 | TIM-542 item 32, TIM-541 item 20 | Tim | not run |  | `rule` | `settings` |
| IMG-95 | TIM-541 item 20 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-96 | TIM-541 item 20 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-97 | TIM-542 item 5, TIM-550 item 5 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| IMG-102 | TIM-541 item 27, TIM-536 item 18 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-103 | TIM-541 item 27 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-104 | TIM-541 item 27 | Architect (Tim has not read) | not run |  | `fact` | `image` |
| IMG-105 | TIM-541 items 24, 25 and 27 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-106 | TIM-541 item 23, TIM-548 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-107 | TIM-541 item 27 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-108 | TIM-541 item 28, TIM-536 item 9 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-109 | TIM-541 item 23 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-110 | TIM-541 item 30 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-111 | TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| IMG-112 | TIM-558 items 20 and 21 | Architect (Tim has not read) | not run | TIM-558 | `rule` | `harness` |
| IMG-113 | TIM-558 items 7, 53, 54 and 55 | Architect (Tim has not read) | not run |  | `definition` | - |
| IMG-114 | TIM-558 item 13 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-115 | TIM-557 item 5 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-116 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-117 | TIM-557 item 38, amended by TIM-559 rulings on STO-G18 and FAIL-G9, which TIM-559 round 3 C4 settles as the connection and the thread | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| IMG-118 | TIM-557 items 1 and 4 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| IMG-119 | TIM-558 item 44, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-120 | TIM-557 items 10 and 33, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| IMG-121 | TIM-559 ruling on IMG-G11 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| IMG-122 | TIM-559 ruling on IMG-G2 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| IMG-123 | TIM-559 rulings on IMG-G2 and MOD-G16 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-124 | TIM-559 ruling on IMG-G3, STO-G2 and STO-G3 | Architect (Tim has not read) | not run | TIM-559 | `definition` | - |
| IMG-125 | TIM-559 ruling on IMG-G5 and STO-G5 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| IMG-126 | TIM-559 ruling on IMG-G5 and STO-G5, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| IMG-127 | TIM-559 ruling on IMG-G5 and STO-G5, TIM-559 cold read, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| IMG-128 | TIM-559 ruling on IMG-G4 (support: the stand-in daemon of TIM-553 used these names) | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| IMG-129 | TIM-559 ruling on IMG-G7 (support: the prototype run exited 1) | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| IMG-131 | TIM-559 ruling on IMG-G8, STO-G25 and SES-G16 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| IMG-133 | TIM-559 main session ruling on Q8, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| IMG-134 | TIM-559 main session ruling on Q8 | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| IMG-138 | TIM-559 ruling on CLI-G3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| IMG-139 | TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `rule` | `skills-mcp` |
| IMG-140 | TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `rule` | `kills` |
| IMG-141 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| IMG-142 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| IMG-143 | Build, stage 3 | Builder (Tim has not read) | run |  | `rule` | `loader` |
| IMG-144 | Build, stage 3 | Builder (Tim has not read) | run |  | `rule` | `loader` |

Retired ids. These rules were withdrawn and removed from this part with their Provenance rows, and the git history of this file holds their text. An id on this list is never used again, and a new rule takes a number above every id in the table and on this list.

IMG-73, IMG-89, IMG-90, IMG-91, IMG-92, IMG-98, IMG-99, IMG-100, IMG-101, IMG-130, IMG-132, IMG-135, IMG-136, IMG-137.
