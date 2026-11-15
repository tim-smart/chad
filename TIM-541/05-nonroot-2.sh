#!/usr/bin/env bash
# Fact 5 extra: a volume that root has already written to, and the lifetime of a tmpfs named volume
IMG=docker.io/library/node:26-trixie-slim
podman volume rm -f chadfacts-nr5 chadfacts-tmpfsvol >/dev/null 2>&1
echo "### F. volume first WRITTEN by a root container, then used by --user node (podman)"
podman run --rm --name chadfacts-nr -v chadfacts-nr5:/data $IMG sh -c 'mkdir -p /data/state && touch /data/state/daemon.lock; ls -ldn /data /data/state'
podman run --rm --name chadfacts-nr --user node -v chadfacts-nr5:/data $IMG sh -c 'id -u; ls -ldn /data /data/state; touch /data/x && echo WRITE-OK || echo WRITE-FAILED; touch /data/state/y && echo WRITE-OK-state || echo WRITE-FAILED-state'
echo "### F2. repair as root: chown -R 1000:1000 /data, then --user node"
podman run --rm --name chadfacts-nr -v chadfacts-nr5:/data $IMG chown -R 1000:1000 /data
podman run --rm --name chadfacts-nr --user node -v chadfacts-nr5:/data $IMG sh -c 'touch /data/x /data/state/y && echo WRITE-OK'
podman volume rm -f chadfacts-nr5 >/dev/null
echo "### G. tmpfs named volume: does content outlive the last container using it?"
podman volume create --opt type=tmpfs --opt device=tmpfs --opt o=size=64m chadfacts-tmpfsvol >/dev/null
podman run --rm --name chadfacts-nr -v chadfacts-tmpfsvol:/data $IMG sh -c 'mkdir -p /data/state && touch /data/state/daemon.lock && ls /data'
podman run --rm --name chadfacts-nr -v chadfacts-tmpfsvol:/data $IMG sh -c 'echo "second container sees: [$(ls /data)]"'
podman volume rm -f chadfacts-tmpfsvol >/dev/null
