#!/usr/bin/env bash
# Fact 5: uid 1000 (node) and a fresh named volume at /data
IMG=docker.io/library/node:26-trixie-slim
T=chadfacts-tools:latest
t() { echo; echo "### $1"; shift; "$@" 2>&1 | sed 's/^/   /'; }
probe='id; ls -ldn /data; touch /data/x && echo WRITE-OK || echo WRITE-FAILED'
for v in chadfacts-nr1 chadfacts-nr2 chadfacts-nr3 chadfacts-nr4 chadfacts-nr5; do podman volume rm -f $v >/dev/null 2>&1; done

t "A. stock image (no /data dir in image), fresh named volume, --user node" \
  podman run --rm --name chadfacts-nr --user node -v chadfacts-nr1:/data $IMG sh -c "$probe"
t "A2. same volume again, second run" \
  podman run --rm --name chadfacts-nr --user node -v chadfacts-nr1:/data $IMG sh -c "$probe"

# image that has /data owned by node, and USER node
mkdir -p 05-img && cat > 05-img/Dockerfile <<'EOF'
FROM docker.io/library/node:26-trixie-slim
RUN mkdir -p /data && chown node:node /data
USER node
EOF
podman build -q -t chadfacts-nonroot:latest 05-img >/dev/null
t "B. image with 'RUN mkdir -p /data && chown node:node /data' + 'USER node', fresh named volume" \
  podman run --rm --name chadfacts-nr -v chadfacts-nr2:/data chadfacts-nonroot:latest sh -c "$probe"
t "B2. the volume first mounted by a root container (stock image), then by the node image" \
  sh -c "podman run --rm --name chadfacts-nr -v chadfacts-nr3:/data $IMG sh -c 'id -u; ls -ldn /data'; podman run --rm --name chadfacts-nr -v chadfacts-nr3:/data chadfacts-nonroot:latest sh -c '$probe'"
t "C. stock image, fresh named volume with :U (podman only: chown volume to the container user)" \
  podman run --rm --name chadfacts-nr --user node -v chadfacts-nr4:/data:U $IMG sh -c "$probe"
mkdir -p /tmp/chadfacts-bind && chmod 755 /tmp/chadfacts-bind
t "D. host bind mount (host dir owned by host uid $(id -u), rootless podman), --user node" \
  podman run --rm --name chadfacts-nr --user node -v /tmp/chadfacts-bind:/data $IMG sh -c "$probe"
t "D2. host bind mount + --userns=keep-id:uid=1000,gid=1000 (rootless podman only)" \
  podman run --rm --name chadfacts-nr --userns=keep-id:uid=1000,gid=1000 --user 1000:1000 -v /tmp/chadfacts-bind:/data $IMG sh -c "$probe"
rm -rf /tmp/chadfacts-bind
t "E. podman volume ownership as seen from the host" \
  sh -c 'for v in chadfacts-nr1 chadfacts-nr2 chadfacts-nr4; do echo "$v: $(stat -c "%u:%g %a" $(podman volume inspect $v --format "{{.Mountpoint}}"))  (host ids; rootless maps container uid 1000 to a subuid)"; done; cat /proc/self/uid_map; grep $(whoami) /etc/subuid'
for v in chadfacts-nr1 chadfacts-nr2 chadfacts-nr3 chadfacts-nr4 chadfacts-nr5; do podman volume rm -f $v >/dev/null 2>&1; done
