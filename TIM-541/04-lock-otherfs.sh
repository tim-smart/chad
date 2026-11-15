#!/usr/bin/env bash
# Fact 4: repeat on other filesystems
IMG=docker.io/library/node:26-trixie-slim
S=$PWD/04-lock
echo "== host: sudo without password? $(sudo -n true 2>&1 && echo yes || echo no)"
echo "== host: block filesystems the kernel has registered: $(grep -v nodev /proc/filesystems | tr -d '\t' | tr '\n' ' ')"
echo "== host: modprobe xfs/btrfs possible as this user? $(modprobe -n xfs 2>&1 | head -1; modprobe -n btrfs 2>&1 | head -1)"
echo
# (a) tmpfs via host bind of /dev/shm
mkdir -p /dev/shm/chadfacts-tmpfs
bash 04-lock.sh "tmpfs (bind mount of host /dev/shm/chadfacts-tmpfs)" /dev/shm/chadfacts-tmpfs 2>&1 | sed -n '1,21p'
rm -rf /dev/shm/chadfacts-tmpfs
echo
# (b) tmpfs named volume
podman volume rm -f chadfacts-tmpfsvol >/dev/null 2>&1
if podman volume create --opt type=tmpfs --opt device=tmpfs --opt o=size=64m chadfacts-tmpfsvol >/dev/null 2>vol.err; then
  bash 04-lock.sh "tmpfs named volume (--opt type=tmpfs)" chadfacts-tmpfsvol 2>&1 | sed -n '1,21p'
else echo "tmpfs named volume: create failed: $(cat vol.err)"; fi
rm -f vol.err; podman volume rm -f chadfacts-tmpfsvol >/dev/null 2>&1
echo
# (c) overlay: the container's own root filesystem (not shareable between containers, so exec only)
echo "################ overlay (container rootfs, exec only)"
podman rm -f -t 0 chadfacts-a >/dev/null 2>&1
podman run -d --name chadfacts-a -v $S:/s:ro $IMG sh -c 'mkdir -p /ovl/state && exec node /s/hold.mjs /ovl/state/daemon.lock hold' >/dev/null; sleep 1
echo "A logs: $(podman logs chadfacts-a 2>&1)"
echo "A fs of /ovl: $(podman exec chadfacts-a sh -c 'df -T /ovl | tail -1')"
echo "exec hold.mjs -> expect REFUSED: $(podman exec chadfacts-a node /s/hold.mjs /ovl/state/daemon.lock 2>&1)"
echo "exec test.mjs -> expect held: $(podman exec chadfacts-a node /s/test.mjs /ovl/state/daemon.lock 2>&1 | tr '\n' ' ')"
podman rm -f -t 0 chadfacts-a >/dev/null 2>&1
# release on overlay: the holder is a background child that is killed with SIGKILL while the container stays up
podman run -d --name chadfacts-a -v $S:/s:ro $IMG sh -c 'mkdir -p /ovl/state && sleep 600' >/dev/null; sleep 0.5
podman exec chadfacts-a sh -c 'node /s/hold.mjs /ovl/state/daemon.lock hold > /ovl/hold.log 2>&1 & echo $! > /ovl/hold.pid; sleep 1; cat /ovl/hold.log'
echo "holder is a background child (pid $(podman exec chadfacts-a cat /ovl/hold.pid)); test -> $(podman exec chadfacts-a node /s/test.mjs /ovl/state/daemon.lock 2>&1 | head -1)"
podman exec chadfacts-a sh -c 'kill -9 $(cat /ovl/hold.pid)'; sleep 0.5
echo "after kill -9 of holder; test -> $(podman exec chadfacts-a node /s/test.mjs /ovl/state/daemon.lock 2>&1 | head -1)"
echo "after kill -9 of holder; hold -> $(podman exec chadfacts-a node /s/hold.mjs /ovl/state/daemon.lock 2>&1 | head -1)"
podman rm -f -t 0 chadfacts-a >/dev/null 2>&1
