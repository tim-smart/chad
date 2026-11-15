# chad Docker image: facts gathered 2026-11-14

Host: rootless podman 5.8.6 (crun, overlay store on ext4). `docker` on PATH is the podman client, so nothing here ran on a real Docker engine. Tags: **RAN** = executed here, **FETCHED** = web page read on 2026-11-14, **READ** = file on disk. Relative paths are under `scratch/docker-facts/`. No design recommendation is made.

## 1. Base image

- **FETCHED** https://hub.docker.com/v2/repositories/library/node/tags?page_size=100&name=26- (2026-11-14). Node 26 tags, current patch 26.13.1, with compressed linux/amd64 size:

| tag | compressed (amd64) | last pushed | arches |
|---|---|---|---|
| 26-alpine = 26-alpine3.24 | 63.0 MB | 2026-11-11 | amd64, arm64 |
| 26-alpine3.23 | 62.8 MB | 2026-11-11 | amd64, arm64 |
| 26-bookworm-slim | 84.1 MB | 2026-11-11 | amd64, ppc64le, arm64 |
| 26-slim = 26-trixie-slim | 85.8 MB | 2026-11-11 | amd64, ppc64le, s390x, arm64 |
| 26-bookworm | 413.5 MB | 2026-11-11 | amd64, ppc64le, arm64 |
| 26 = 26-trixie | 444.9 MB | 2026-11-11 | amd64, ppc64le, s390x, arm64 |
| 26-bullseye-slim / 26-bullseye | 85.5 / 385.9 MB | 2026-08-27 (stale) | amd64, arm64 |
| 26-alpine3.22 | 62.5 MB | 2026-06-02 (stale) | amd64, arm64 |

  Versioned forms also exist (26.13, 26.13.1, each with the same suffixes).
- **RAN** (`01-base.sh`, `logs/01-base.log`) unpacked sizes from `podman images`: bookworm-slim 251 MB, trixie-slim (= `26-slim`, same image id) 255 MB, alpine 182 MB.
- **RAN** in all three: the default user is root (`Config.User` is empty). `node` is `uid=1000(node) gid=1000(node)`, home `/home/node`. Entrypoint `docker-entrypoint.sh`, cmd `node`, no `STOPSIGNAL` set.
- **RAN** node:26-trixie-slim:

  ```
  v26.13.1            (npm 11.20.0)
  node:sqlite ok 3.54.1
  ldd (Debian GLIBC 2.41-12+deb13u4) 2.41
  bash: present /usr/bin/bash
  git: MISSING   curl: MISSING   wget: MISSING   tini: MISSING   rg: MISSING   sqlite3: MISSING   gh: MISSING
  python3: MISSING   corepack: MISSING   yarn: MISSING   pnpm: MISSING   ps: MISSING
  ca-certificates: MISSING (/etc/ssl/certs/ca-certificates.crt)
  node fetch https status 200        (node's bundled CA store works without the package)
  ```
- **RAN** node:26-bookworm-slim: the same list, glibc `2.36-9+deb12u14`, Debian 12. `/home/node` is mode 755 on bookworm and 700 on trixie.
- **RAN** node:26-alpine: musl, Alpine 3.24, **no bash**, has busybox wget and ps, has ca-certificates, node:sqlite ok 3.54.1.

## 2. Tools the agent needs

**What clanka spawns (READ, clanka 88a1e05)**

- `src/AgentTools.ts:719`: `ChildProcess.make("bash", ["-c", options.command], …)` for the `bash` tool. `run` (line 900) goes through the same call.
- `src/AgentTools.ts:877`: `ChildProcess.make("rg", args, …)` for the `rg` tool.
- `src/AgentTools.ts:993`: `ChildProcess.make("gh", args, …)` for the `gh` tool.
- Those are the only three `ChildProcess.make` calls in `src/` (grep). clanka never spawns `git` itself; git only runs if the model calls it through `bash`.
- Other processes: stdio MCP servers run whatever `command` the config names (`src/McpServers.ts:325-330`, via `StdioClientTransport`). The optional claude provider looks for `CLANKA_CLAUDE_PATH`, then `claude` on PATH, and fails with "Claude Code was not found…" (`src/ClaudeAgent.ts:651-665`).
- When a binary is missing (READ + RAN): all three tool bodies end in `Effect.orDie` (`AgentTools.ts:750, 885, 1014`), so a spawn failure becomes a defect of that tool call. There is no fallback and no PATH probe. RAN `02-missing-binary.sh` in the stock slim image with the same effect spawner:

  ```
  bash exit=0 out="hi\n"
  rg FAILED: … "reason":{"_tag":"NotFound","module":"ChildProcess","method":"spawn","pathOrDescriptor":"rg --version","syscall":"spawn rg","cause":{"errno":-2,"code":"ENOENT",…}} … "_tag":"PlatformError"
  gh FAILED: … same shape, "spawn gh" ENOENT
  git FAILED: … same shape, "spawn git" ENOENT
  ```
  I did not run a clanka agent end to end, so how the defect is worded to the model is not shown.
- clanka depends on `@vscode/ripgrep ^1.18.0` (`package.json:39`), but nothing in `src/` or the published `dist` references it (RAN `02-vscode-ripgrep.sh`: grep of `node_modules/clanka/dist` for `vscode/ripgrep|rgPath` is empty). After `npm install` an `rg` 15.0.0 binary (5.7 MB) sits at `node_modules/@vscode/ripgrep-linux-x64/bin/rg`. It is not linked into `node_modules/.bin` and `rg` is not on PATH.
- On alpine there is no bash (fact 1), so the `bash` and `run` tools would hit the same ENOENT.

**Tools image (RAN: `02-tools/Dockerfile`, `logs/02-build.log`, `02-versions.sh`, `logs/02-versions.log`)** on node:26-trixie-slim, apt with `--no-install-recommends` and the apt lists removed:

| layer | adds | version |
|---|---|---|
| ca-certificates + curl | 16.6 MB | ca-certificates 20250419+deb13u1, curl 8.14.1 |
| git | 90.1 MB | git 2.47.3 |
| ripgrep + sqlite3 | 7.38 MB | ripgrep 14.1.1, sqlite3 3.46.1 |
| tini (apt) | 1.98 MB | tini 0.19.0 |
| gh (GitHub apt repo) | 42.4 MB | gh 2.104.0 (2026-11-12) |
| uv + uvx (`COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/`) | 43.2 MB | uv 0.13.8 (static musl build) |

  Result: **456 MB unpacked** (456,384,175 bytes) against 255 MB for the base (254,776,583), about +202 MB. The compressed size of the built image was not measured. There is no python3 in the image; uv downloads its own (fact 6).
- gh on Debian. **FETCHED** https://raw.githubusercontent.com/cli/cli/trunk/docs/install_linux.md (2026-11-14): the "Recommended (Official)" method is the apt repo `https://cli.github.com/packages` with the keyring `githubcli-archive-keyring.gpg` in `/etc/apt/keyrings`. That is what the Dockerfile does (with curl in place of wget). The same page says of Debian's own package: "As of November 2025, GitHub CLI maintainers strongly recommend official Debian packages especially as the community-distributed 2.45.x / 2.46.x version is broken due to deprecated GitHub APIs." **RAN**: Debian's own candidate is gh 2.46.0-3 on trixie and 2.23.0 on bookworm. The release-tarball route was not run.
- Debian candidates on bookworm, for comparison (**RAN**): git 2.39.5, ripgrep 13.0.0, sqlite3 3.40.1, tini 0.19.0.
- uv. **FETCHED** https://docs.astral.sh/uv/guides/integration/docker/ (2026-11-14): shows `COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/`, says "it is best practice to pin to a specific uv version", and gives `ghcr.io/astral-sh/uv:0.13.8` and an `@sha256:` digest form as examples.
- esbuild and typescript@7 (**RAN** `02-npm-size.sh`, `logs/02-npm-size.log`; npm install into a temp dir in the slim image, then `du -sh node_modules`):

  ```
  npm install esbuild               12M   (esbuild 0.28.2; @esbuild/linux-x64 is 11M)
  npm install typescript@7          31M   (typescript 7.0.2; the @typescript/* native package is 27M; bin: tsc)
  npm install esbuild typescript@7  42M
  ```
  npm dist-tags for typescript: latest 7.0.2, rc 7.0.1-rc, beta 7.1.0-beta.

## 3. PID 1 and signals

**RAN** `03-signals.sh`, `03-signals/graceful.mjs`, `logs/03-signals.log` on node:26-trixie-slim. `podman inspect` showed `StopSignal=SIGTERM StopTimeout=10` for every container.

| case | PID 1 | `podman stop` took | exit | node saw SIGTERM |
|---|---|---|---|---|
| a. `node graceful.mjs` (through the image entrypoint, which execs) | node | 3305 ms | 0 | yes: "got SIGTERM, shutting down in 3s", then "graceful exit" |
| b. same with `--init` | podman-init, node is pid 2 | 3373 ms | 0 | yes, forwarded |
| c. node script with **no** SIGTERM handler | node | 10537 ms | 137 | signal ignored, SIGKILL at the 10 s timeout |
| d. same with `--init` | podman-init | 265 ms | 143 | default action applied, dies at once |
| e. `sh -c 'node graceful.mjs; echo …'` | sh, node is pid 3 | 10281 ms | 137 | **no**, nothing logged, SIGKILL |
| f. `--entrypoint "" /bin/sh -c 'node graceful.mjs'` (shell-form equivalent) | sh, node is pid 2 | 10505 ms | 137 | **no** |

- Orphan reaping (**RAN**, same script): two `podman exec c sh -c '(sleep 1 &); exit 0'` sessions, plus one orphan made by node's own `bash -c` child. All three orphans were reparented to PID 1.

  ```
  without --init, 2.5s later:            with --init, 2.5s later:
  pid=1 (node-MainThread) state=S        pid=1 (podman-init) state=S
  pid=11 (sleep) state=Z ppid=1          pid=2 (node-MainThread) state=S ppid=1
  pid=14 (sleep) state=Z ppid=1          -- zombies: 0
  pid=17 (sleep) state=Z ppid=1
  -- zombies: 3
  ```
- podman's `--init` binary is catatonit, not tini (**RAN**: `/run/podman-init --version` prints "tini version 0.2.1_catatonit"). Debian's `tini` package in the tools image is 0.19.0 (fact 2). Running tini as the image's own entrypoint was not tested.
- **FETCHED** https://docs.docker.com/reference/dockerfile/ (2026-11-14): "STOPSIGNAL … The default is SIGTERM if not defined."
- **FETCHED** https://docs.docker.com/reference/cli/docker/container/stop/ (2026-11-14): "The main process inside the container will receive SIGTERM, and after a grace period, SIGKILL." And: "If no default is configured for the container, the Daemon determines the default, and is 10 seconds for Linux containers".
- **FETCHED** https://docs.docker.com/reference/cli/docker/container/run/ (2026-11-14): `--stop-timeout -1` waits indefinitely. `--init` uses `docker-init`, "backed by tini".
- **FETCHED** https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/ (2026-11-14): "The default terminationGracePeriodSeconds setting is 30 seconds." The kubelet asks the runtime to send TERM to the main process of each container, then SIGKILL when the grace period expires.

## 4. The lock and the socket on a shared volume

**RAN** `04-lock.sh`, `04-lock/{hold,test,server,client}.mjs`, `logs/04-lock-named.log`. Named volume `chadfacts-vol` (local driver, a bind of `~/.local/share/containers/storage/volumes/…/_data`, ext4). hold.mjs and test.mjs are unmodified copies from `scratch/lock/`.

```
A logs: HELD by 1
A /proc/locks: 5: POSIX  ADVISORY  WRITE 1 08:00:28311746 1073741824 1073742335
1. B (second container, same volume) hold.mjs:  REFUSED: ERR_SQLITE_ERROR database is locked
2. B test.mjs:                                  held (database is locked)   test took 3.648481 ms
3. podman exec in A hold.mjs:                   REFUSED: ERR_SQLITE_ERROR database is locked
4. podman exec in A test.mjs:                   held (database is locked)   test took 3.675973 ms
5. podman kill A (SIGKILL)                      A state: exited exit=137
6. B test.mjs after kill:                       free   test took 3.71803 ms
7. B hold.mjs after kill:                       HELD by 1
   files: daemon.lock is 0 bytes, no journal file left
```

Unix socket, same volume:

```
A logs: listening on /data/run/chad.sock mode 755 uid 0
8.  client via podman exec in A:                       CONNECTED: hello from server pid 1 uid 0
9.  client from container B (own network namespace):   CONNECTED: hello from server pid 1 uid 0
10. client from container B as uid 1000 (--user node): CONNECT ERROR: EACCES     (socket is root-owned, mode 755)
11. after podman kill A the socket file remains; client: CONNECT ERROR: ECONNREFUSED
12. new server on the stale path, no unlink:           LISTEN ERROR: EADDRINUSE
13. new server after unlinking the stale path:         listening …, client CONNECTED
```

Other filesystems (**RAN** `04-lock-otherfs.sh`, `logs/04-lock-otherfs.log`):

- tmpfs, a host `/dev/shm` directory bind-mounted into A and B: steps 1-7 give the same results (REFUSED, held, REFUSED, held, then free and HELD after the kill).
- tmpfs named volume (`podman volume create --opt type=tmpfs`): steps 1-4 the same. Step 6 failed for an unrelated reason: the volume is unmounted when its last container exits and its contents are gone (**RAN** `05-nonroot-2.sh` case G: the second container sees `[]`), so `/data/state` no longer existed.
- overlay (the container's own root filesystem, which containers cannot share, so exec only): holder as PID 1, exec hold.mjs REFUSED, exec test.mjs held. With the holder as a background child killed by `kill -9`: test "free", hold "HELD by 32".
- Could not try xfs or btrfs: `/proc/filesystems` lists only ext3, ext4, fuseblk and vfat as block filesystems, and there is no root (`sudo` refuses: the "no new privileges" flag is set). Host mounts are ext4 and tmpfs only.

Kubernetes volume types:

- SQLite. **FETCHED** https://www.sqlite.org/faq.html (2026-11-14), Q5: "this locking mechanism might not work correctly if the database file is kept on an NFS filesystem. This is because fcntl() file locking is broken on many NFS implementations." **FETCHED** https://www.sqlite.org/howtocorrupt.html section 2.1: "some filesystems contain bugs in their locking logic … This is especially true of network filesystems and NFS in particular". The default unix locking is POSIX advisory locking.
- local-path: **local**. **FETCHED** https://raw.githubusercontent.com/rancher/local-path-provisioner/master/README.md (2026-11-14): it creates "either hostPath or local based persistent volume on the node". In this cluster the directory is `/var/local-path-provisioner` (READ `k3s-config/office/src/local-path-storage/00-bundle.yaml:137-141`). Which filesystem the node has there was not checked.
- Longhorn RWO: **a local filesystem on a replicated block device**. **FETCHED** https://longhorn.io/docs/latest/concepts/ (2026-11-14, docs 1.13.0): "The Longhorn CSI driver takes the block device, formats it, and mounts it on the node." **FETCHED** https://github.com/longhorn/longhorn/issues/6636 (via search): maintainer comment "If user doesn't provide fsType Longhorn will use ext4 by default". Locks are then handled by the node's ext4 or xfs.
- Longhorn RWX: **not local**. **FETCHED** https://longhorn.io/docs/latest/nodes-and-volumes/volumes/rwx-volumes/ (2026-11-14): RWX volumes are exposed "via NFSv4 servers that reside in share-manager pods" (NFSv4.1).
- NFS: **network**. **FETCHED** https://man7.org/linux/man-pages/man5/nfs.5.html (2026-11-14): NFSv3 locking uses the NLM sideband protocol. With `nolock`, "applications can lock files, but such locks provide exclusion only against other applications running on the same client. Remote applications are not affected by these locks." I did not capture the man page's text on NFSv4's in-protocol locking.
- CephFS: **network**. docs.ceph.com returned 403. **FETCHED** https://tracker.ceph.com/issues/23 (via search): fcntl/flock advisory locks are supported by the kernel client (target 2.6.36), and "all locking requests are routed through the MDS".
- Nothing was run on NFS, CephFS or Longhorn.

## 5. Non-root

**RAN** `05-nonroot.sh`, `05-nonroot-2.sh`, `05-img/Dockerfile`, `logs/05-nonroot.log`, `logs/05-nonroot-2.log` (rootless podman).

| case | `ls -ldn /data` | write as uid 1000 |
|---|---|---|
| A. stock image (no `/data` in it), fresh named volume, `--user node` | 1000:1000 755 | WRITE-OK |
| B. image with `RUN mkdir -p /data && chown node:node /data` and `USER node`, fresh named volume | 1000:1000 755 | WRITE-OK |
| B2. volume first mounted (nothing written) by a root container, then B's image | 0:0, then 1000:1000 | WRITE-OK |
| C. stock image, `-v vol:/data:U` (podman-only flag) | 1000:1000 | WRITE-OK |
| **F. volume first written by a root container, then `--user node`** | 0:0 755 | **WRITE-FAILED** ("Permission denied") |
| F2. after `chown -R 1000:1000 /data` as root | 1000:1000 | WRITE-OK |
| **D. host bind mount, `--user node`** | 0:0 (the host owner maps to container root) | **WRITE-FAILED** |
| D2. bind mount with `--userns=keep-id:uid=1000,gid=1000` (rootless podman only) | 1000:1000 | WRITE-OK |

- So podman chowns an empty named volume to the container's user on first use, even when the image has no directory at the mount point (case A). That is podman behaviour as observed here. It was not verified on Docker.
- Docker. **FETCHED** https://docs.docker.com/engine/storage/volumes/ (2026-11-14): "If you mount an empty volume into a directory in the container in which files or directories exist, these files or directories are propagated (copied) into the volume by default." The passages I matched on that page do not mention ownership. The ownership rule is stated in community answers only. **FETCHED** https://serverfault.com/questions/984578/ (via search): "Named volumes are initialized when first created to the contents of the image at the mount location. That initialization includes the owner and permissions." **FETCHED** https://stackoverflow.com/questions/39564861/ (via search): "Automatically created named volumes will generally use the local driver, and create the matching mount point as root:root". The fixes shown there are `RUN mkdir -p /data && chown -R 1000 /data` in the Dockerfile, or a one-off root container that runs `chown`. None of this was run on Docker.
- Kubernetes. **FETCHED** https://kubernetes.io/docs/tasks/configure-pod-container/security-context/ (2026-11-14): "By default, Kubernetes recursively changes ownership and permissions for the contents of each volume to match the fsGroup specified in a Pod's securityContext when that volume is mounted". `fsGroupChangePolicy: OnRootMismatch` limits that. The field "only applies to volume types that support fsGroup controlled ownership and permissions". Not run: there is no kubectl, kind or cluster on this machine.
- READ: the existing Hermes pod uses `fsGroup: 10000` with `fsGroupChangePolicy: OnRootMismatch` (`k3s-config/office/compiled/hermes/20-deployment.yaml:277-279`). The cluster's local-path setup script creates each volume directory with `mkdir -m 0777 -p "$VOL_DIR"` (`src/local-path-storage/00-bundle.yaml:144-147`). Whether the kubelet applies fsGroup to local-path volumes was not checked.

## 6. Runtime installs

**RAN** `06-runtime-installs.sh`, `logs/06-runtime-installs.log`: tools image, `--user node`, fresh named volume at `/data`, `HOME=/data/home`, `NPM_CONFIG_PREFIX=/data/home/.npm-global`, PATH prefixed with `/data/home/.npm-global/bin:/data/home/.local/bin`.

- `npm install -g cowsay` works. `npm prefix -g` is `/data/home/.npm-global`, the npm cache is `/data/home/.npm`, the binary is `/data/home/.npm-global/bin/cowsay`.
- The same without the prefix: `npm error code EACCES … mkdir '/usr/local/lib/node_modules/cowsay'`.
- uv: `uv tool dir` is `/data/home/.local/share/uv/tools`, the tool bin dir is `/data/home/.local/bin`, the cache is `/data/home/.cache/uv`, the python dir is `/data/home/.local/share/uv/python`. `uv tool install pycowsay` worked and first downloaded cpython-3.15.2 (114 MB under the python dir). `uvx ruff --version` worked (ruff 0.17.5), cached under `/data/home/.cache/uv` (27 MB).
- `apt-get install -y jq` as uid 1000: `E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)`, then `are you root?`. The `exit=0` printed after it in the log is the exit status of `tail`, not of apt. `sudo` is not in the image.
- uid 1000 cannot write `/usr/local/bin` or `/opt`. It can write `/tmp` and `/home/node`.
- `podman diff` of that container (changes to the image filesystem, so not on the volume): `/home/node/x`, `/tmp/x` and `/tmp/node-compile-cache/v26.13.1-x64-…/*` (node's compile cache). Nothing from npm or uv.
- A second, new container on the same volume: `cowsay`, `pycowsay`, `uv tool list` and the uv-managed Python are all still there. `/tmp/x` and `/home/node/x` are gone.

## 7. The existing deployment

This section described a private deployment and is left out of the public copy. The asphodel facts it held are in the spec, in docs/spec/18-asphodel-plugin.md and docs/spec/01-image-and-volume.md.

## 8. Pinning effect

- **FETCHED** https://raw.githubusercontent.com/stackblitz-labs/pkg.pr.new/main/README.md (2026-11-14): `npm i https://pkg.pr.new/${owner}/${repo}/${package}@{commit}`. Compact URLs (`https://pkg.pr.new/tinybench@a832a55`) are the default in generated comments and "rely on your package being published on npm".
- **READ** `src/effect/.github/workflows/snapshot.yml:49`: `pnpm exec pkg-pr-new publish --pnpm --comment=off ./packages/* ./packages/atom/* ./packages/ai/* ./packages/chat/* ./packages/platform/* ./packages/sql/* ./packages/tools/*`, so every package under those globs is published at each snapshot commit.
- **READ** package names at 0b51fb1, all at version 4.1.4:
  - `effect` (`packages/effect`), no runtime dependencies.
  - `@effect/platform-node` (`packages/platform/node`): deps `@effect/platform-node-shared: workspace:*` and `undici ^8.12.4`; peers `effect: workspace:^` and `redis >=5.1.0 <7.0.0`.
  - `@effect/platform-node-shared`: deps `ws ^8.22.1` and `@types/ws`; peer effect.
  - `@effect/sql-sqlite-node` (`packages/sql/sqlite-node`): peer effect.
  - `@effect/chat-discord` (`packages/chat/discord/package.json:2, 68-69`): peers **`dfx ^1.1.1`** and effect.
  - `@effect/chat-slack` (`packages/chat/slack/package.json:2, 68`): peer effect only.
  - `packages/chat` contains only `discord` and `slack`.
- **READ** `src/clanka/package.json:43-48` (version 0.27.0): peerDependencies `@effect/ai-openai ^4.0.0`, `@effect/ai-openai-compat ^4.0.0`, `@effect/platform-node ^4.0.0`, `effect ^4.0.0`. Dependencies: `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `@silvia-odwyer/photon-node`, `@vscode/ripgrep`, `chalk`, `turndown`. dfx is not a clanka dependency.
- **RAN** `08-effect-install.sh`, `08-effect-install-2.sh`, `logs/08-effect-install.log`, `logs/08-effect-install-2.log` in node:26-trixie-slim.
  - npm 11.20.0, `npm install https://pkg.pr.new/Effect-TS/effect/effect@0b51fb1 https://pkg.pr.new/Effect-TS/effect/@effect/platform-node@0b51fb1 clanka@0.27.0`: exit 0, 128 packages, **exactly one copy of effect**.

    ```
    find: node_modules/effect/package.json -> 4.1.4          (the only match)
    node_modules/effect                       4.1.4 https://pkg.pr.new/Effect-TS/effect/effect@0b51fb1
    node_modules/@effect/platform-node        4.1.4 https://pkg.pr.new/Effect-TS/effect/@effect/platform-node@0b51fb1
    node_modules/@effect/platform-node-shared 4.1.4 https://pkg.pr.new/Effect-TS/effect/@effect/platform-node-shared@0b51fb176db86e796a914921b11c544eac2670af
    node_modules/@effect/ai-openai            4.1.4 https://registry.npmjs.org/@effect/ai-openai/-/ai-openai-4.1.4.tgz (peer)
    node_modules/@effect/ai-openai-compat     4.1.4 https://registry.npmjs.org/@effect/ai-openai-compat/-/ai-openai-compat-4.1.4.tgz (peer)
    node_modules/clanka                       0.27.0 https://registry.npmjs.org/clanka/-/clanka-0.27.0.tgz
    ```
    The snapshot package rewrites its workspace dependency to a full-SHA pkg.pr.new URL and its effect peer to `^4.1.4`. clanka's two ai peers were auto-installed from the npm registry (release 4.1.4), not from the snapshot, and they share the snapshot's effect. `node_modules` is 546 MB: `@anthropic-ai` (claude-agent-sdk and its platform binary) is 380 MB, effect 65 MB, @effect 23 MB.
  - pnpm 12.18.0 with default settings and the same three specifiers **fails**:

    ```
    Error: ERR_PNPM_EXOTIC_SUBDEP
    Failed to resolve dependency tree: Exotic dependency "@effect/platform-node-shared" (resolved via url) is not allowed in subdependencies when blockExoticSubdeps is enabled
    ```
  - pnpm with `blockExoticSubdeps: false` in `pnpm-workspace.yaml`: exit 0, one `node_modules/.pnpm/effect@https+++pkg.pr.new+…0b51fb1_…` directory and one `effect/package.json`. pnpm also wrote `minimumReleaseAgeExclude: [clanka@0.27.0]` into the workspace file on its own.
  - pnpm with that setting, an `overrides: { effect: <snapshot URL> }` block, and also `@effect/sql-sqlite-node`, `@effect/chat-discord`, `@effect/chat-slack` from the snapshot and `dfx` from npm: exit 0, still one effect directory, dfx resolved to 1.1.1 against the snapshot effect. The run without the overrides block already had one copy, so this run does not show whether the override changes anything.
  - Registry state (**RAN** `npm view`): effect, @effect/platform-node, @effect/ai-openai and @effect/sql-sqlite-node are at 4.1.4; dfx at 1.1.1; **clanka's latest is 0.28.0**. `npm view` of `@effect/chat-discord` and `@effect/chat-slack` returned an npm error. I kept only its last line, so the error code is not recorded. Both installed fine from pkg.pr.new.

## 9. Health checks

- **FETCHED** https://docs.docker.com/reference/dockerfile/ (2026-11-14), HEALTHCHECK: the status starts as `starting`, becomes `healthy` on a pass, and `unhealthy` "after a certain number of consecutive failures". Defaults: `--interval=30s`, `--timeout=30s`, `--start-period=0s`, `--start-interval=5s`, `--retries=3`. Exit 0 is healthy, 1 is unhealthy. "When the health status of a container changes, a health_status event is generated". The section describes status and events only and names no restart action.
- **FETCHED** https://docs.docker.com/engine/containers/start-containers-automatically/ (2026-11-14): restart policies are worded in terms of the container exiting or stopping (`on-failure`: "if it exits due to an error, which manifests as a non-zero exit code"; `always`: "if it stops"). The lines I matched do not mention health. I found no Docker docs sentence that says outright that unhealthy containers are not restarted.
- **FETCHED** (community, via search) https://stackoverflow.com/questions/57535192/, accepted answer: "Docker only reports the status of the healthcheck. Acting on the healthcheck result requires an extra layer running on top of docker. Swarm mode provides this functionality". https://serverfault.com/questions/890948/: with `docker run`, "docker will do nothing to the container"; a Swarm service "will stop/kill the task (container) and reschedule a new task".
- Compose. **FETCHED** https://docs.docker.com/reference/compose-file/services/ (2026-11-14): `healthcheck` "works in the same way, and has the same default values, as the HEALTHCHECK Dockerfile instruction". `depends_on` with `condition: service_healthy` makes Compose wait for a dependency to be healthy before starting the dependent service. The `restart` values (`no`, `always`, `on-failure[:max-retries]`, `unless-stopped`) are described by exit code and stop state, not by health.
- Kubernetes probe defaults. **FETCHED** https://kubernetes.io/docs/concepts/workloads/pods/probes/ (2026-11-14, via search; my direct fetch of https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/ returned the same text, saved as `logs/fetch/k8s-probes-concept.md`): `initialDelaySeconds` "Defaults to 0 seconds"; `periodSeconds` "Default to 10 seconds. The minimum value is 1"; `timeoutSeconds` "Defaults to 1 second"; `successThreshold` "Defaults to 1"; `failureThreshold` "Defaults to 3. Minimum value is 1". These fields are shared by exec, httpGet, tcpSocket and grpc probes. The same page says an exec probe forks processes on every run and "might introduce an overhead on the cpu usage of the node".
- startupProbe. **FETCHED** https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/ (2026-11-14): "If a startup probe is configured, Kubernetes does not execute liveness or readiness probes until the startup probe succeeds, allowing the application time to finish its initialization. If the startup probe fails, the kubelet kills the container, and the container is subjected to its restart policy." And: "If a container fails its liveness probe more times than the configured tolerance, the kubelet restarts that container."

## Not checked

- Nothing ran on a real Docker engine or on Kubernetes. Every Docker and Kubernetes behaviour above comes from documentation or community answers. The Docker named-volume ownership rule and the fsGroup failing/working pair were not run.
- Whether the kubelet applies fsGroup to local-path (hostPath) volumes, and which filesystem the cluster node has under `/var/local-path-provisioner`.
- Lock tests on xfs, btrfs, NFS, CephFS and Longhorn (no kernel support or no root here). The official CephFS docs (403). The NFSv4 locking text in nfs(5).
- The tools image was built on trixie-slim only, not on bookworm-slim or alpine. Its compressed size and the arm64 sizes were not measured. uv was taken at `:latest` (0.13.8), not pinned. gh from a release tarball was not tried. tini as the image's own ENTRYPOINT was not tried; only podman's `--init`, which is catatonit.
- A real clanka agent run with a missing binary. Only the effect spawner call was run and the code read.
- A unix socket with the server running as uid 1000, and socket file modes other than the default 755.
- The asphodel and Hermes images were not pulled or inspected.
- How long pkg.pr.new keeps a snapshot, and whether a lockfile integrity hash pins its content.
- chad's own build (the esbuild bundle and the final image size with node_modules), since there is no chad source yet.

## Files (all under `scratch/docker-facts/`)

- Scripts: `01-base.sh`, `02-tools/Dockerfile`, `02-versions.sh`, `02-npm-size.sh`, `02-missing-binary.sh` (with `02-missing-binary/spawn.mjs`), `02-vscode-ripgrep.sh`, `03-signals.sh` (with `03-signals/graceful.mjs` and `nohandler.mjs`), `04-lock.sh`, `04-lock-otherfs.sh` (with `04-lock/hold.mjs`, `test.mjs`, `server.mjs`, `client.mjs`), `05-nonroot.sh`, `05-nonroot-2.sh`, `05-img/Dockerfile`, `06-runtime-installs.sh`, `08-effect-install.sh`, `08-effect-install-2.sh`.
- Logs in `logs/`: `01-pull.log`, `01-base.log`, `01-hub-tags.json`, `02-build.log`, `02-versions.log`, `02-npm-size.log`, `02-missing-binary.log`, `02-vscode-ripgrep.log`, `03-signals.log`, `04-lock-named.log`, `04-lock-otherfs.log`, `05-nonroot.log`, `05-nonroot-2.log`, `06-runtime-installs.log`, `08-effect-install.log`, `08-effect-install-2.log`, and the fetched pages in `logs/fetch/*.md`.
- Clone: `asphodel-src/asphodel`. This report: `REPORT.md`.

Cleanup: every `chadfacts-*` container and volume is removed, and the two images I built (`chadfacts-tools`, `chadfacts-nonroot`) are deleted. Left behind: the pulled images `node:26-bookworm-slim`, `node:26-trixie-slim` (= `26-slim`), `node:26-alpine` and `ghcr.io/astral-sh/uv:latest` in the podman store, and the `workdir/k3s-config` checkout made by the multica CLI. Nothing was posted to Multica or GitHub and no ticket was touched. Elapsed: about 17 minutes of the 30.
