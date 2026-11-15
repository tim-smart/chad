# The chad image built and run

A prototype for "The chad image built and run" (TIM-553). It builds the image "Docker image and data volume layout" (TIM-541) decided, around a stand-in daemon, and runs it on a real Docker engine. There is no chad source yet, so the daemon here is small. It does the parts the image design depends on and nothing else.

128 checks passed and none failed in the last full pass, which ran every script against the final image. `logs/results.txt` has every line, with what was seen in brackets.

There were four passes. The first had 102 checks. Architect then reviewed it twice standing in for Tim, and each review added checks and changed the stand-in. The third pass hung, because a second daemon was let in on a volume that already had one. That is finding 1 below. "Changed after Architect's review" lists what changed between passes.

## What is here

- `chad/Dockerfile`: the two-stage build.
- `chad/package.json`, `chad/pnpm-workspace.yaml`, `chad/pnpm-lock.yaml`, `chad/vendor/`: the pnpm files and the seven effect tarballs, at the SHA in `vendor/SHA`.
- `chad/bin/chad.js`: the launcher.
- `chad/src/`: the stand-in daemon (`daemon.ts`), the CLI (`cli.ts`) and the plugin API the type-check needs.
- `chad/plugins/`: stand-ins for the bundled plugins, as TypeScript.
- `tests/`: one script per subject. `common.sh` holds the helpers and `mcp-probe.mjs` is a small stdio MCP server.
- `logs/`: the build logs, one log per script, and `results.txt`.
- `vm/`: how the Docker engine was started. The disk images and the key are not in the archive.

## The engine

This machine's `docker` is a wrapper around rootless podman, which is what TIM-541 ran on. So the runs here are in a Debian 13 guest under KVM with Docker CE 29.9.3, buildx 0.39.0, the containerd image store, cgroup v2 and kernel 6.12. The guest's user is uid 1000.

To run it again on any Docker host:

```
cd chad && docker build -t chad:proto .
cd ../tests && for t in 0*.sh 1*.sh; do bash $t; done   # writes ~/logs/results.txt
```

`13-fs.sh` needs `nfs-kernel-server`, `sshfs` and sudo. `14-arm64.sh` needs `chad:proto-arm64` and QEMU's binfmt handlers. `17-runner-close.sh` and `21-lock-gc.mjs` run on the host with node 26, outside the image.

The logs under `logs/` named `swap-suite-*`, `session-*` and `hooks-*` are not from this prototype. They are the suites of "The plugin swap run with live sessions" (TIM-552) and "The Session entity run on SingleRunner and SQLite" (TIM-543), run again at 1 shard. Their code is in those tickets' archives, and `other-suites/` has the two patches these runs applied to it: a `PROTO_SHARDS` setting in both, and in the TIM-543 one the shard guard, the two shard scenarios and the longer turn. `logs/15-install-no-pkg-pr-new.log` is from the first pass and was not repeated, because the lockfile did not change.

## What the stand-in daemon does

It takes the SQLite lock, counts the boot, listens on the socket, opens the database, links `repo/node_modules` and `repo/examples`, loads clanka's MCP layer from `repo/work/mcp.json` and runs a Session entity on `SingleRunner`. A turn sleeps for a set time and can start a background command the way clanka's `bash` tool does. `--mode stuck` makes a turn that ignores interruption.

It has no model, no Discord, no plugins loaded, no hooks, no migrations and no safe mode.

## What held

Build and packages

- The `overrides` entry redirects the nested pkg.pr.new edge. The lockfile names no pkg.pr.new URL, and a clean `pnpm install --frozen-lockfile` passes with pkg.pr.new unreachable (`logs/15-install-no-pkg-pr-new.log`).
- `node_modules` holds one copy of effect, on amd64 and arm64.
- The Claude SDK's JavaScript is installed, its platform binary is not, and `clanka/ClaudeAgent` imports in the final image.
- The tarballs are 12.8 MB together. `effect.tgz` is 10.8 MB of that.
- pnpm 12 needed three settings TIM-541 did not name: `enableGlobalVirtualStore: false`, `allowBuilds` for esbuild, and a `minimumReleaseAgeExclude` entry for clanka 0.27.0, which pnpm wrote itself.
- The first builds took 1 min 14 s for amd64 and 3 min 14 s for arm64 under emulation. The two build logs here are from the last rebuild, which reused cached layers (12 s and 27 s).

Size

- 697 MB unpacked, against the 650 MB TIM-541 estimated. 197 MB compressed for amd64 and 194 MB for arm64. The base image is 81 MB compressed.
- The largest parts unpacked are `node_modules` at 243 MB (effect is 64 MB of it), the node binary at 144 MB and uv at 41 MB.

The launcher

- `bin/chad.js` is 6 lines. `serve` imports the daemon as separate files. Every other command imports one bundled file of 664 KB.
- `chad health` takes 117 ms at the median and 154 ms at the slowest of 30 runs. The same command unbundled takes 353 ms. `chad health` now also tests the lock, which did not change the median.

Writing a plugin from `/data/repo`

- A plugin that imports `chad` and `effect/Effect` passes `tsc` from `repo/node_modules`, and a wrong one fails with TS2345. The `chad` import resolves through a link `node_modules/chad -> ..` made in the Dockerfile.
- `exports` lists `.`, `./Plugin`, `./Session` and `./Turns` only. `import "chad/daemon"` fails the type-check.
- Every path the `self-edit` skill names exists. The effect tarball carries `AGENTS.md` (19 KB) and `ai-docs/src` (79 files).
- `repo/examples` is a link to the bundled plugins' source. uid 1000 cannot write through it, `git status` in `work/` does not show it, and under a later image it shows that image's source.

tini

- PID 1 is tini and the daemon is its only child. SIGTERM reached the daemon's handler 35 to 51 ms after `docker stop` in three passes and 436 ms after in one.
- The session's background command was signalled by chad 15.0 s later, and not by tini. The stdio MCP server was never signalled: it ended when chad closed it, 15.0 s after SIGTERM.
- Under `tini -g` the MCP server got SIGTERM in the same millisecond as the daemon. That is the case TIM-541 chose plain tini to avoid.
- An orphan that exits is reaped under tini and stays a zombie without it.

The volume

- A fresh named volume belongs to uid 1000 and the daemon boots. So does a host directory owned by uid 1000.
- A named volume first written by root, a host directory Docker created for the mount, a directory owned by uid 1001 and a run as uid 2000 are each refused with a message that names the uid and the owner. A refused boot writes nothing.
- A writable volume whose `repo/` belongs to another uid is refused, naming both. git does refuse such a repository.

PATH and caches

- `npm install -g` and `uv tool install` work as uid 1000 with no Python in the image, their commands are on PATH, and both are still there after the container is replaced.
- A `git`, `chad`, `node`, `npm` or `rg` dropped in either volume bin directory does not shadow the image's.
- The npm and uv caches land under `cache/` and nothing is cached under `home/`.

`CHAD_SESSION`

- The image does not set it. `chad serve` sets `daemon`, and a stdio MCP server and that server's child both have it. A session's command has the session id. A `docker exec` shell has none.
- A session's command has `TZ` set to the owner's timezone and the daemon does not. `date` prints NZDT for `Pacific/Auckland`, so the base image has the zone files.

Boot

- `chad status` answered 1.2 s after `docker run` (1.8 s in the first run) and named the phase `database`. `chad health` passes in that phase and Docker marked the container healthy at 2.7 s.
- A second `chad serve` on the volume is refused the lock, exits 1 and is not counted.

Stop

- Idle, the daemon exits by itself 32 to 38 ms after SIGTERM, with exit code 0. That is at 1 shard, which the stand-in now uses. At cluster's default of 300 shards it took 1.5 to 2.1 s, nearly all of it `SingleRunner` closing.
- With a turn running it exits at 15.0 s, which is the cluster's entity termination timeout. The runner closes 8 to 14 ms after the entities at either shard count, so its close adds nothing when a turn is being waited for.
- Under Docker's default 10 seconds the kill comes first, and the counter is already 0. Three such restarts each counted 1.
- `docker kill` three times counted 1, 2, 3.

Health

- `chad health` against a daemon stopped with SIGSTOP exits 1 after 2 seconds. Docker reported the container unhealthy 97 s after the freeze and restarted nothing, with `--restart unless-stopped` set.
- Stopping the frozen daemon leaves the counter at 1, so it counts as unclean.

Filesystem

- On NFS, as a host directory and as a Docker volume of type nfs, the daemon warns in the log and in `chad status` and keeps running.
- On a named volume on ext4 there is no warning.
- With no volume mounted, and with `/data` on tmpfs, the daemon boots and warns that nothing will survive.

arm64

- The arm64 image boots to ready, answers `chad health`, and runs tsc, esbuild, git, rg, gh, sqlite3 and uv. This was under QEMU emulation on an amd64 host.

## What the run found

1. The daemon lock can be lost while the daemon runs. The lock is a SQLite write transaction held open. Nothing referred to its handle after boot, so a garbage collection closed it. In the third pass a second `chad serve` on the same volume was let in, and both ran and reported healthy for 30 minutes. The first two passes passed that check by luck. `logs/21-lock-gc.log` shows it in 20 lines of node: a handle that is dropped is free after a collection, one that is kept is held. In the image, with a collection every 200 ms, the daemon that keeps the handle still holds the lock and a second serve is refused. The one that drops it has lost the lock, still answers `chad status`, and fails `chad health`.
2. A turn that ignores interruption keeps the daemon alive. With a 90 second grace period it never exits by itself and Docker kills it at 90 s. TIM-541 says chad exits within 60. With a timer of chad's own started in the SIGTERM handler it exits at 60.0 s with code 1, and the boot counter is already 0.
3. The idle close of `SingleRunner` costs about 7 ms per shard, and cluster's default is 300 shards. `logs/17-runner-close.log`: 2.0 to 2.2 s at 300, 0.7 to 2.6 s at 100, 70 ms at 10 and 10 to 12 ms at 1. In the container with 24 busy loops on 8 CPUs it took 1.9 to 2.7 s at 300 and 9 to 53 ms at 1. The cause of the 7 ms was not looked for.
4. A changed shard count strands what is stored. Two timers stored at 300 shards were not delivered in 60 s after a restart at 1 shard, and nothing was logged. Back at 300 they were delivered. With a guard that keeps the count in a database row, the daemon at 1 shard refused to start and named both numbers. Both ran in the TIM-543 prototype (`logs/session-suite-at-1-shard.results.txt`, `shards-changed` and `shards-guard`).
5. At 300 shards a stop slows the rest of the daemon for its first seconds. A scripted 15.1 s turn in the TIM-543 suite was still running 16.0 s after it started, which is the only reason that suite's `term-mid-turn` passed. At 1 shard the turn finished first. With a 30 s turn the stop cut it 15.05 s after SIGTERM and the next boot resumed it once, at 1 shard, twice out of two.
6. clanka closes stdio MCP servers one after another, and one that ignores its stdin closing and SIGTERM takes 4.0 s. Three took 12.0 s. Building clanka's layer in a scope that runs its finalizers at once changed nothing (12.0 s). A turn and three such servers exit 0 at 27.1 s. A turn and twelve are cut by chad's deadline at 60.0 s, exit 1, and the log line names the servers.
7. `CHAD_DATA` moves the daemon's files, the socket and the links. It does not move `HOME`, the caches, the npm prefix or PATH, which the image fixes at `/data`. With `CHAD_DATA=/srv/chad` an `npm install -g` landed on the container's own layer and was gone when the container was replaced. The daemon now warns for each of the three that is on the container's layer or on tmpfs. Outside a container it gives no warning.
8. A `CHAD_DATA` deep enough to make the socket path 129 bytes is refused with the length and `CHAD_SOCKET` named. With `CHAD_SOCKET=/tmp/chad.sock` it boots. Without the check Node says `listen EINVAL`.
9. On sshfs the daemon cannot create its socket (EPERM) and exits 1 after the warning. With `CHAD_SOCKET=/tmp/chad.sock` the lock was taken and the database opened, then making the links failed. So chad does not run on sshfs at all. That the lock was taken there says nothing about whether it would keep a second machine out.
10. On NFS just after the NFS server restarted, the daemon logged the warning and then blocked in the kernel for 58 or 59 s in four runs and 102 s in a fifth, before it listened. `chad status` said there was no daemon.
11. The socket listens 0.8 to 1.3 s after the container starts. Importing clanka is 0.76 s of that. Until then `chad status` says there is no daemon.
12. clanka's `McpServers.layer` fails a server whose `env` values are plain strings, with "Unable to get redacted value". They have to be `Redacted`.
13. A cut turn is delivered again at every boot by the stand-in (9 starts for 3 turns asked). The stand-in has no "resumed once" rule, so this says nothing about chad.

## The earlier suites at 1 shard

Every check in TIM-543 and TIM-552 ran at 300 shards. Since chad will use 1, both were run again at 1.

- TIM-543's suite: 96 checks, 0 failed, with the two shard scenarios added and `term-mid-turn`'s turn raised to 30 s. Before that change it failed 3 checks at 1 shard for the reason in finding 5. One other check failed once (`passivate`, the model provider's cache on the first call after a restore) and then passed twice at each count.
- TIM-552's suite, three full runs: 121 of 122, then 122, then 122. The one failure was "\[hooks\] when the plugin was removed its queued hook was dropped and logged". It did not come back in 40 runs of that scenario alone, 20 at each count, or in 8 on a CPU shared with three busy loops. Its log was overwritten, so the cause was not seen. It was reproduced by forcing an order: with the first hook short enough to finish before the second turn ends, the second hook is already running when the plugin is removed, finishes on the old version, and the same one check fails while the other six pass (`logs/hooks-forced-order.txt`). That is the agreed rule for a hook that is running, so the check assumes a timing and the swap is not at fault. This is an inference from a matching result, not a reading of the failed run.

## Changed after Architect's review

- `exports` lists the public modules only. It was `./*`, which made every built file importable.
- A stop the daemon finished exits 0. It exited 130. A forced stop exits 1, and its log line names what was still open.
- Boot replaces a link at `repo/examples` or `repo/node_modules` without asking. Anything else there is moved to `<name>.replaced-<timestamp>` and logged. It used to be deleted.
- The filesystem warning also covers the container's own layer and tmpfs, follows `CHAD_DATA` to the mount that holds it, and is run on `HOME`, the npm prefix and the cache too.
- The socket error has two forms. A path over 107 bytes names `CHAD_SOCKET`. A filesystem that cannot hold a socket is named as unsupported.
- `/etc/profile.d/chad.sh` puts the volume's bin directories back in a login shell, last and once. Debian's `/etc/profile` resets PATH, so `bash -l` used to lose them. clanka runs `bash -c` and was never affected.
- The daemon runs at 1 shard.
- The daemon keeps the lock's handle until it exits.
- `chad health` tests the lock before the ping. It used to ping only.
- A session's command gets `TZ` from the owner's timezone.

## Not run

- Kubernetes: the probes, `fsGroup` on a local-path volume, the CronJob.
- The filesystem on Tim's node. `stat -f -c %T /var/local-path-provisioner` answers it.
- CephFS, SMB and Longhorn.
- arm64 on real hardware.
- Compose, asphodel as a second service and the backup cron line.
- Log rotation, the pre-migration copy, a newer `state/version`, safe mode.
- The 35 seconds for queued hooks in the stop, and plugin scopes closing before the MCP layer. The stand-in has no hooks and no plugins.
- "A turn cut off by a restart is resumed once".
- The shard guard in the image's stand-in. It ran in the TIM-543 prototype only.
- The TIM-552 suite a fourth time at 1 shard, and three times at 300 for comparison.
- Docker marking a daemon that lost its lock as unhealthy. `chad health` failing was run, the 90 seconds of failed probes were not waited for.
