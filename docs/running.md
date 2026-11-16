# Running chad

chad ships as one image, `ghcr.io/tim-smart/chad`, built for amd64. Each image is tagged with chad's version and no
prefix, such as `ghcr.io/tim-smart/chad:0.0.0`, and that is the same string `chad status` prints and the volume's
`state/version` holds, so a tag always matches a running chad. The examples pin a version tag. Use the version you
want in place of `0.0.0`.

Everything chad keeps lives on one volume mounted at `/data`. The volume has to be a local filesystem: a host
directory, a named Docker volume, a Kubernetes local-path volume, a cloud block volume or Longhorn RWO. NFS, CephFS,
SMB and Longhorn RWX are not supported, because SQLite's lock and write-ahead log are not safe on them.

## The image

Building and publishing the image is done by hand, from the root of the repository:

```sh
version=$(node -p 'require("./package.json").version')
docker build --platform linux/amd64 -t "ghcr.io/tim-smart/chad:$version" .
docker push "ghcr.io/tim-smart/chad:$version"
```

The image runs as the `node` user, uid 1000, and has no sudo and no apt. A tool the agent needs is installed with npm
or uv, which keep what they install on the volume, or is a single binary in `/data/home/.local/bin`.

## Docker

There is one way to a running chad. Start the container, then run the setup wizard inside it:

```sh
docker volume create chad-data
docker run -d --name chad --restart unless-stopped --stop-timeout 90 \
  -v chad-data:/data \
  ghcr.io/tim-smart/chad:0.0.0
docker exec -it chad chad setup
```

`--stop-timeout 90` gives chad the time a stop needs. Docker's default of 10 seconds kills a stop that is still
waiting for a turn to finish.

Every other command runs the same way, as `docker exec -it chad chad <command>`. Before the first start you can also
run a command in a one-off container against the volume, such as `docker run --rm -it -v chad-data:/data
ghcr.io/tim-smart/chad:0.0.0 setup`.

For a shell in a one-off container, replace the entrypoint:

```sh
docker run --rm -it -v chad-data:/data --entrypoint bash ghcr.io/tim-smart/chad:0.0.0
```

A host directory works in place of the named volume when it belongs to uid 1000 (`sudo chown 1000:1000 <dir>`).
chad refuses to boot on a volume another uid owns, and writes nothing to it.

### When chad freezes

chad's health check is `chad health`, and Docker marks a frozen chad unhealthy. Under plain Docker nothing restarts an
unhealthy container: `--restart unless-stopped` restarts chad when it exits, and a freeze is not an exit. Restart it
yourself with `docker restart chad`. On Kubernetes the liveness probe does it.

### Other mounts

You can give chad other directories, such as an Obsidian vault. Mount each one under `/mnt`, as `/mnt/vault` here,
and add `:ro` when chad should only read it:

```sh
docker run -d --name chad --restart unless-stopped --stop-timeout 90 \
  -v chad-data:/data \
  -v /srv/vault:/mnt/vault:ro \
  ghcr.io/tim-smart/chad:0.0.0
```

A mount like this is outside chad's repo, so chad never commits it and `chad revert` never touches it. Backing it up
is up to you.

### asphodel

asphodel, the memory daemon the asphodel plugin talks to, is not in the chad image. It runs as its own container on a
network it shares with chad. Its image runs as uid and gid 65532 and has no `/data`, so give it the volume first, as
its README does. Then start it with a token that chad is given too:

```sh
docker volume create asphodel-data
docker run --rm --user 0:0 --entrypoint /bin/sh -v asphodel-data:/data \
  ghcr.io/tim-smart/asphodel:latest -c 'chown 65532:65532 /data'

token=$(openssl rand -hex 32)
docker network create chad
docker network connect chad chad
docker run -d --name asphodel --restart unless-stopped --network chad \
  -p 127.0.0.1:7720:7720 \
  -e ASPHODEL_TOKEN="$token" \
  -v asphodel-data:/data \
  ghcr.io/tim-smart/asphodel:latest \
  serve --listen 0.0.0.0:7720 --data-dir /data
printf %s "$token" | docker exec -i chad chad secret set ASPHODEL_TOKEN
```

asphodel then waits for its first-run setup: open `http://127.0.0.1:7720/dashboard` on the host. Keep the port bound
to `127.0.0.1`, because whoever reaches an unconfigured asphodel first can set it up.

The plugin's `url` is `http://asphodel:7720`. Its `token` setting is `${ASPHODEL_TOKEN}`, which chad reads
from its secret store or from its own environment.

### Backup

`chad backup` writes one tar that holds the database, the repo, the secrets and the home directory. The tar holds
the Discord token, the Codex login and every saved secret, so keep it as you keep a password, and write it so that only
you can read it. With chad running:

```sh
backup="chad-$(date +%F).tar"
rm -f "$backup"
(umask 077 && docker exec chad chad backup - > "$backup") || rm -f "$backup"
ls -l "$backup"   # -rw-------
```

The `umask` makes a new file owner-only. It does nothing to a file that already exists: a redirect into one keeps its
old mode, and anyone who already opened it reads what is written into it. That is why `rm -f` comes first. A backup that fails is deleted
rather than left as a partial tar.

asphodel's store is not in that tar. It holds what asphodel remembers about you, so back it up next to it the same way.
`asphodel backup --out -` streams the copy and exits non-zero when its length or hash does not check out, and the
`rm` then deletes what it wrote:

```sh
backup="asphodel-$(date +%F).db"
rm -f "$backup"
(umask 077 && docker exec asphodel asphodel backup --out - > "$backup") || rm -f "$backup"
ls -l "$backup"   # -rw-------
```

### Restore

A restore goes onto an empty volume, with chad stopped:

```sh
docker stop chad
docker rename chad chad-old
docker volume create chad-restored
docker run --rm -i -v chad-restored:/data ghcr.io/tim-smart/chad:0.0.0 restore - < chad-2026-11-16.tar
docker run -d --name chad --restart unless-stopped --stop-timeout 90 \
  -v chad-restored:/data \
  ghcr.io/tim-smart/chad:0.0.0
```

If chad uses asphodel, add `--network chad` to the last `docker run`, or chad cannot reach `http://asphodel:7720`.
Keep `chad-old` and the old volume until the restored chad answers, then remove them with `docker rm chad-old` and
`docker volume rm chad-data`. `docs/live-checks.md`, check D4, restores asphodel next to it.

`chad restore` refuses a volume that holds secrets or sessions, and a volume a running chad holds. A restore that was
cut part way leaves the volume to `chad restore` alone: run the same restore again and it finishes. A newer chad
restores an older tar, and the first boot migrates it.

## Kubernetes

chad ships no manifests for Kubernetes. A deployment of your own has to set the following.

- One replica with `strategy: Recreate`, so a rollout stops the old pod before the new one starts. A second chad on
  the same volume is refused the lock.
- One ReadWriteOnce claim mounted at `/data`, and `runAsUser: 1000` with `fsGroup: 1000`. On a local-path volume
  `fsGroup` does nothing, because the provisioner makes the directory with mode 0777, and chad's own start-up check is
  the guard: it refuses to boot on a volume another uid owns.
- `chad health` as the liveness probe, every 30 seconds with a 5 second timeout and 3 failures, so a frozen chad is
  restarted. A frozen chad is not a crash, and nothing else restarts it. A startup probe runs the same command every 2
  seconds, up to 30 times. chad needs no readiness probe.
- `terminationGracePeriodSeconds: 90`. A stop takes up to 60 seconds.
- asphodel next to chad, as a native sidecar in chad's pod: an init container with `restartPolicy: Always`, on its
  own volume. The plugin reaches it at `http://127.0.0.1:7720`. Give both containers the same `ASPHODEL_TOKEN` from
  one Secret: a `${NAME}` that chad's secret store does not hold comes from chad's environment.
- A backup job that runs the chad image with the data claim and a destination mounted, as `chad backup
/backup/chad-<date>.tar`, with `concurrencyPolicy: Forbid`. It mounts the claim itself, so it works while chad's
  pod is down. asphodel's store is not in that tar: back it up next to it with `asphodel backup`, as in the Docker
  section.

A ReadWriteOnce claim is attached to one node at a time but does not draw the pods that use it to the same node. On a
cluster of one node, such as a k3s server, every pod that mounts the claim runs where it is. On several nodes, place the
backup job and a restore pod yourself.

Set chad up once its pod runs. Every other command runs the same way:

```sh
kubectl exec -it deploy/chad -- chad setup
```

asphodel waits for its first-run setup. Reach its dashboard through a port forward and open
`http://127.0.0.1:7720/dashboard`:

```sh
kubectl port-forward deploy/chad 7720:7720
```

### Restore on Kubernetes

Stop chad, restore onto an empty claim from a one-off pod, and point the Deployment at that claim. `stdinOnce` closes
the pod's standard input once the tar has been sent, as `kubectl run -i` does when no override replaces the container:

```sh
kubectl scale deploy/chad --replicas=0
kubectl wait --for=delete pod -l app.kubernetes.io/name=chad --timeout=5m
# The label is whatever your Deployment gives chad's pod. Create an empty claim, chad-restored, then:
kubectl run chad-restore --rm -i --restart=Never --image=ghcr.io/tim-smart/chad:0.0.0 \
  --overrides='{"spec":{"securityContext":{"runAsUser":1000,"fsGroup":1000},"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"chad-restored"}}],"containers":[{"name":"chad-restore","image":"ghcr.io/tim-smart/chad:0.0.0","args":["restore","-"],"stdin":true,"stdinOnce":true,"volumeMounts":[{"name":"data","mountPath":"/data"}]}]}}' \
  < chad-2026-11-16.tar
# Point the Deployment's data volume and the backup job at chad-restored, then:
kubectl scale deploy/chad --replicas=1
```
