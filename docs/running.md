# Running chad

chad ships as one image, `ghcr.io/tim-smart/chad`, built for amd64. Each image is tagged with chad's version and no
prefix, such as `ghcr.io/tim-smart/chad:0.0.0`, and that is the same string `chad status` prints and the volume's
`state/version` holds, so a version tag always matches a running chad. The examples pin a version tag. Use the
version you want in place of `0.0.0`. Each image also has the tag `main` and a tag for its commit, which "The image"
describes.

Everything chad keeps lives on one volume mounted at `/data`. The volume has to be a local filesystem: a host
directory, a named Docker volume, a Kubernetes local-path volume, a cloud block volume or Longhorn RWO. NFS, CephFS,
SMB and Longhorn RWX are not supported, because SQLite's lock and write-ahead log are not safe on them.

## The image

A push to `main` publishes the image. `.github/workflows/publish.yml` builds it for amd64 and pushes it to
`ghcr.io/tim-smart/chad` with three tags:

- `main`, which is the head of `main` as it was when the tags were last moved with success. A deployment that
  follows chad uses this one with the pull policy `Always`, and gets that image each time chad's container starts.
- chad's version, such as `0.0.0`. It moves with `main` until the version changes.
- The commit, such as `sha-4d3d587`, which is `sha-` and the first seven characters of the commit. Every push to
  `main` whose build succeeds gets one, and it only ever names an image built from that commit, so it says which
  commit an image is. A run that is started again builds the commit again and can give the tag another digest. When
  the image itself must not change, pin the digest, as `ghcr.io/tim-smart/chad@sha256:...`.

Each push builds its own image, and pushes do not wait for each other. A second job then moves `main` and the version
tag, one run at a time, to the image of whatever commit is the head of `main` at that moment. A build that finishes
late, or a run that is started again, therefore cannot move them back to an older commit.

That second job fails when it has not moved both tags, and there are three ways it does:

- Two pushes came close together, and the earlier run found that the later commit has no image yet. Nothing is
  wrong. The later run moves the tags when its build is done.
- The build of the head failed, so no run has an image to move the tags to. They stay on an older commit.
- The registry failed, which can leave `main` moved and the version tag not.

For the last two, start the failed jobs again with `gh run rerun <run id> --failed`: of the head's run when its build
failed, and of the run whose second job failed when the registry did. Either moves both tags to the head. The three
tags of the head then have one digest:

```sh
for tag in main 0.0.0 sha-4d3d587; do
  docker buildx imagetools inspect "ghcr.io/tim-smart/chad:$tag" --format '{{.Manifest.Digest}}'
done
```

Building and pushing by hand still works, from the root of the repository:

```sh
version=$(node -p 'require("./package.json").version')
docker build --platform linux/amd64 -t "ghcr.io/tim-smart/chad:$version" .
docker push "ghcr.io/tim-smart/chad:$version"
```

The image runs as the `node` user, uid 1000, and has no sudo and no apt. A tool the agent needs is installed with npm
or uv, which keep what they install on the volume, or is a single binary in `/data/home/.local/bin`.

What needs root to install is in the image already:

- For development: git, `gh`, curl, wget, jq, `rg`, `fd`, make, patch, rsync, `file`, tree, less, sqlite3, zip, unzip,
  bzip2, xz and zstd. `python3` is there with no packages and no pip, and uv uses it in place of downloading its own.
- For documents: `pandoc` converts between Markdown, HTML, docx, odt, epub and the other formats it reads and writes,
  and makes a PDF with `--pdf-engine=typst`. poppler's commands read a PDF, `pdftotext`, `pdftoppm`, `pdfimages` and
  `pdfinfo` among them, and `qpdf` merges, splits, rotates, encrypts and decrypts one.
- For images: ImageMagick's `magick`, which also reads HEIC and AVIF, `rsvg-convert` for SVG, and `pngquant`,
  `jpegoptim` and `gifsicle`, which make a PNG, a JPEG and a GIF smaller.

The image has no OCR, no Ghostscript, no LibreOffice, no LaTeX and no ffmpeg. A Python library, such as pypdf or
Pillow, comes with `uv run --with`.

A tool you want kept goes in `work/package.json` in the repo, as a plugin's package does. The commands of those packages
are on PATH, from `/data/repo/live/node_modules/.bin`, which follows the applied tree: an apply puts a command there and
a revert takes it away, with no restart. That directory comes last on PATH, after the volume's other bin directories,
so no package can shadow a tool of the image. Install scripts never run, so a tool that needs one does not work.

A plugin can import npm packages that `work/package.json` in the repo names. chad installs them with `npm ci` into
`/data/repo/packages/`, one directory for each lockfile, with npm's cache in `/data/cache/npm`. An apply or a revert
whose lockfile changed needs the network unless the cache holds every package it names, and so does the first start
after a restore. One whose lockfile did not change installs nothing. A start waits for the install before it loads the repo's
plugins. With no network npm gives up after about a minute, and the start then skips the plugins that import a
missing package, with the reason in `chad status`, and loads the rest. An install that runs for five minutes is stopped.

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

### Fast mode

`chad model --fast on`, or `/model --fast on` in Discord, sends chad's OpenAI requests on the `priority` service tier,
which answers faster and costs more. `--fast off` turns it off, and off is the default. It combines with a model change,
as in `/model openai/gpt-6-astra/high --fast on`, and `chad model` with no argument shows whether it is on. A running
session uses the new setting from its next turn, with no restart.

It applies to `openai` models, on the Codex login or with `CHAD_OPENAI_API_KEY`, and to the sub-agent and summarizer
models with them. `openai-compat`, `copilot` and `xai` have no fast mode: chad keeps the setting and sends no tier, and
`chad model` says it is ignored. It applies again when the main model moves back to `openai`.

Turning it on makes a trial request with the tier set, and a model or an account that refuses it leaves the setting as
it was. The tier is best effort on OpenAI's side: not every model, region or project serves it, and one that does not
can answer on the default tier.

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

chad's long-term memory is the bundled plugin `asphodel`. It talks to an asphodel daemon, which is not in the chad
image. The daemon runs as its own container on a network it shares with chad. Its image runs as uid and gid 65532 and
has no `/data`, so give it the volume first, as its README does. Then start it with a token that chad is given too:

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
to `127.0.0.1`, because whoever reaches an unconfigured asphodel first can set it up. With no LLM chosen there, asphodel
stores each turn but extracts no memories from it.

The plugin is off until you turn it on, and `chad status` shows it as `plugin: asphodel, off`. While it is off it
sends nothing and gives the model no memory tools. To turn it on, add its entry to `/data/repo/work/chad.json`, keeping
any plugin already in it:

```json
{
  "plugins": {
    "asphodel": {
      "enabled": true,
      "settings": {
        "url": "http://asphodel:7720",
        "token": "${ASPHODEL_TOKEN}",
        "ownerName": "Tim"
      }
    }
  }
}
```

Then run `docker exec chad chad apply -m "Turn asphodel on"`. `chad status` lists the plugin with its settings once
it has loaded. `"enabled": false`, or deleting the entry, turns it off again at the next apply. Its data stays in
either case.

The settings are these. Only `url` and `token` are needed.

- `url`: where the daemon listens, `http://` or `https://`. The default is `http://127.0.0.1:7720`, which is right for
  a sidecar in the same pod.
- `token`: the daemon's bearer token. `${ASPHODEL_TOKEN}` is read from chad's secret store or from its own
  environment, and the value never reaches a log.
- `bank`: the bank in the daemon that chad's memories go to and come from. The default is `chad`, which a daemon that
  Hermes has been using does not have yet, so chad starts with no memories. To give chad what Hermes remembers, set
  `bank` to the bank Hermes used, which is the name of the Hermes profile unless you changed it.
- `ownerName` and `assistantName`: the names the daemon gives you and chad, `chad` for the assistant by default.
- `timezone`: an IANA name for the turns chad sends. The default is the timezone `chad timezone` set.
- `ingest`: `false` keeps recall and stops chad sending turns.

When the daemon is down, chad works as before without memory. A load while it is down logs `asphodel: memory is off
until the daemon is back`, the system prompt has no memory block, and the turns that could not be sent wait in the plugin's store, up to
500 of them and none older than a week. After three failed requests in a row the plugin sends nothing for 30 seconds.
Once the daemon answers again the next turn gets its block and the waiting turns are sent, at the latest a minute
later. The memory tools answer that the daemon cannot be reached.

Safe mode never loads the plugin, even when `chad.json` turns it on, because safe mode reads no settings and the
plugin has nothing to reach the daemon with. Nothing said in safe mode is remembered, and `chad status` shows the
plugin as off until safe mode ends.

A volume that already has a copy of the plugin at `work/plugins/asphodel.ts` has its next apply refused, because a
repo plugin cannot have a bundled plugin's name. Delete the copy and turn the bundled one on as above. It uses the same
store, so it keeps what the copy had spooled.

### Backup

`chad backup` writes one tar that holds the database, the repo, the secrets and the home directory. The tar holds
the Discord token, the Codex login and every saved secret, so keep it as you keep a password, and write it so that only
you can read it. With chad running:

```sh
backup="chad-$(date +%F).tar"
tmp=$(mktemp "$backup.XXXXXX") &&
  { docker exec chad chad backup - > "$tmp" && mv -f "$tmp" "$backup" ||
    { rc=$?; rm -f "$tmp"; (exit "$rc"); }; }
```

The tar is written to a new file next to the target, which `mktemp` makes readable by you alone whatever the umask, and
it replaces the target only once the backup has succeeded. A backup that fails removes only that new file and exits
with the backup's status, so an earlier backup of the same name is kept as it was. When the directory cannot be written
to, `mktemp` fails and nothing is touched. Once it succeeds, `ls -l "$backup"` shows `-rw-------`.

asphodel's store is not in that tar. It holds what asphodel remembers about you, so back it up next to it the same way.
`asphodel backup --out -` streams the copy and exits non-zero when its length or hash does not check out:

```sh
backup="asphodel-$(date +%F).db"
tmp=$(mktemp "$backup.XXXXXX") &&
  { docker exec asphodel asphodel backup --out - > "$tmp" && mv -f "$tmp" "$backup" ||
    { rc=$?; rm -f "$tmp"; (exit "$rc"); }; }
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

The tar holds `work/package.json` and its lockfile but not the installed packages, so the first start after a restore
installs them again and needs the network to do so.

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
