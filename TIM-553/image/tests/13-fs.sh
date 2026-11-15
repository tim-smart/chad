#!/usr/bin/env bash
# The filesystem under /data, and the warning on one that is not local.
T=fs; . "$(dirname "$0")/common.sh"
st() { wait_phase $1 ready 100; x $1 chad status | grep -E 'phase|data volume|warning' | tr '\n' ' '; }
down() { sudo umount -l /mnt/chadt-nfs /mnt/chadt-sshfs 2>/dev/null; sudo rm -rf /srv/chadt-nfs /mnt/chadt-nfs /mnt/chadt-sshfs ~/chadt-sshfs-src; }
down

start named
expect "a named volume on the engine's disk: no warning" "$(st named)" 'phase: ready data volume: ext4 \(/dev/[a-z0-9]+ at /data\) *$'

sudo mkdir -p /srv/chadt-nfs/bind /srv/chadt-nfs/vol /mnt/chadt-nfs && sudo chown -R 1000:1000 /srv/chadt-nfs
echo "/srv/chadt-nfs 127.0.0.1(rw,sync,no_subtree_check,no_root_squash,insecure)" | sudo tee /etc/exports >/dev/null
sudo systemctl restart nfs-kernel-server && sudo exportfs -ra
sudo mount -t nfs4 127.0.0.1:/srv/chadt-nfs /mnt/chadt-nfs || fail "could not mount NFS"
# First, a daemon started right after the NFS server restarted. Its first file open blocks in the kernel.
docker run -d --name chadt-nfs0 -v /mnt/chadt-nfs/bind:/data $IMG >/dev/null; g=$(now_ms)
sleep 8
expect "FOUND: on NFS just after the server restarted, the daemon warns and then blocks before it listens, so chad status has no answer" "$(docker logs chadt-nfs0 2>&1 | wc -l) log line, $(docker logs chadt-nfs0 2>&1 | tail -1 | cut -c40-80), status: $(x nfs0 chad status | head -1 | cut -c1-80), blocked in $(x nfs0 sh -c 'cat /proc/$(pgrep -P 1)/wchan')" '^1 log line, .*volume\.warning.*status: chad status: .*blocked in nfs'
for k in $(seq 1 100); do x nfs0 chad status | grep -q 'phase: ready' && break; sleep 2; done
note "how long that daemon took to reach ready" "$(( ($(now_ms) - g) / 1000 )) s, with the server's grace time set to $(sudo cat /proc/fs/nfsd/nfsv4gracetime) s"
docker rm -f chadt-nfs0 >/dev/null; sudo rm -rf /srv/chadt-nfs/bind/* /srv/chadt-nfs/bind/.[a-z]* 2>/dev/null
docker run -d --name chadt-nfs -v /mnt/chadt-nfs/bind:/data $IMG >/dev/null
expect "a host directory on NFS: the daemon warns at boot and in chad status, and does not refuse" "$(st nfs)" 'phase: ready data volume: nfs4 .* warning: /data is on nfs4\. chad needs a local filesystem'
expect "the warning is in the log" "$(ev nfs volume.warning)" '"type":"nfs4"'

docker volume create --driver local --opt type=nfs --opt o=addr=127.0.0.1,rw,nfsvers=4 --opt device=:/srv/chadt-nfs/vol chadt-nfsvol >/dev/null
docker run -d --name chadt-nfsvol -v chadt-nfsvol:/data $IMG >/dev/null
expect "a Docker volume of type nfs: warned the same" "$(st nfsvol)" 'data volume: nfs4 .* warning: /data is on nfs4'

mkdir -p ~/chadt-sshfs-src ~/.ssh && sudo mkdir -p /mnt/chadt-sshfs
test -f ~/.ssh/id_ed25519 || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519
grep -qf ~/.ssh/id_ed25519.pub ~/.ssh/authorized_keys || cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
sudo sshfs -o allow_other,IdentityFile=/home/tim/.ssh/id_ed25519,StrictHostKeyChecking=no,UserKnownHostsFile=/dev/null tim@127.0.0.1:/home/tim/chadt-sshfs-src /mnt/chadt-sshfs 2>/dev/null || fail "could not mount sshfs"
docker run -d --name chadt-fuse -v /mnt/chadt-sshfs:/data $IMG >/dev/null
r=$(st fuse)
expect "a host directory on FUSE (sshfs): the daemon cannot create its socket there, says which filesystem and what to set, and exits 1" "running=$(docker inspect chadt-fuse --format '{{.State.Running}} exit={{.State.ExitCode}}'), $(docker logs chadt-fuse 2>&1 | grep -v '^{' | head -1)" 'running=false exit=1, chad serve: cannot create the socket /data/run/chad\.sock \(E[A-Z]+\)\. /data/run is on fuse\.sshfs, which cannot hold a unix socket\. chad needs a local filesystem under /data'
expect "it warned before it failed" "$(ev fuse volume.warning)" 'fuse\.sshfs'

docker rm -f chadt-fuse >/dev/null; rm -rf ~/chadt-sshfs-src/* 2>/dev/null
docker run -d --name chadt-fuse -e CHAD_SOCKET=/tmp/chad.sock -v /mnt/chadt-sshfs:/data $IMG >/dev/null; sleep 8
expect "FOUND: the same sshfs volume with CHAD_SOCKET=/tmp/chad.sock: the lock is taken and the database opens, then making the links fails, so chad does not run there at all" "running=$(docker inspect chadt-fuse --format '{{.State.Running}} exit={{.State.ExitCode}}'), reached $(docker logs chadt-fuse 2>&1 | grep -o '"phase":"[a-z]*"' | tail -1), $(docker logs chadt-fuse 2>&1 | grep -o 'EPERM: operation not permitted, [a-z]* [^ ]*' | head -1)" "running=false exit=1, reached \"phase\":\"loading\", EPERM: operation not permitted, (readlink|symlink) '/data/repo/"
docker run -d --name chadt-none $IMG >/dev/null
expect "no volume mounted at all: the daemon boots and warns that nothing will survive the container" "$(st none)" "phase: ready data volume: overlay \(overlay at /\) warning: /data is on the container's own filesystem, not on a volume"
docker run -d --name chadt-tmpfs --tmpfs /data:uid=1000,gid=1000 $IMG >/dev/null
expect "/data on tmpfs: warned as memory" "$(st tmpfs)" 'phase: ready data volume: tmpfs \(tmpfs at /data\) warning: /data is on tmpfs, which is memory'
clean; down
