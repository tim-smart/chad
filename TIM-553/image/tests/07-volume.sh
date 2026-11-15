#!/usr/bin/env bash
# uid 1000 on the volumes Docker can hand it, and the start-up check.
T=volume; . "$(dirname "$0")/common.sh"
sudo rm -rf /srv/chadt; sudo mkdir -p /srv/chadt
# outcome <name>: the phase if the daemon is up, else its exit code and what it said
outcome() { sleep 3; if [ "$(docker inspect chadt-$1 --format '{{.State.Running}}')" = true ]; then wait_phase $1 ready 50; echo "running, $(x $1 chad status | grep phase), /data is $(x $1 stat -c '%u:%g %a' /data)"; else echo "exit $(docker inspect chadt-$1 --format '{{.State.ExitCode}}'): $(docker logs chadt-$1 2>&1 | tail -1)"; fi; }

docker run -d --name chadt-fresh -v chadt-fresh:/data $IMG >/dev/null
expect "a fresh named volume: Docker gives it the image's owner, and the daemon boots" "$(outcome fresh)" 'phase: ready, /data is 1000:1000 755'

docker volume create chadt-root >/dev/null
docker run --rm -v chadt-root:/vol alpine sh -c 'touch /vol/written-by-root' 2>/dev/null
docker run -d --name chadt-root -v chadt-root:/data $IMG >/dev/null
expect "a named volume first written by root: refused, naming the uid and the owner" "$(outcome root)" 'exit 1: chad serve: cannot write /data\. chad runs as uid 1000, gid 1000 and /data is owned by uid 0, gid 0, mode 755'

mkdir -p ~/chadt-host && rm -rf ~/chadt-host/* 
docker run -d --name chadt-host -v ~/chadt-host:/data $IMG >/dev/null
expect "a host directory owned by uid 1000: the daemon boots" "$(outcome host)" 'phase: ready, /data is 1000:1000'

docker run -d --name chadt-auto -v /srv/chadt/auto:/data $IMG >/dev/null
expect "a host directory Docker created for the mount: refused, because Docker makes it as root" "$(outcome auto)" 'exit 1: chad serve: cannot write /data\..*owned by uid 0, gid 0'

sudo mkdir -p /srv/chadt/other && sudo chown 1001:1001 /srv/chadt/other
docker run -d --name chadt-other -v /srv/chadt/other:/data $IMG >/dev/null
expect "a host directory owned by uid 1001: refused" "$(outcome other)" 'exit 1: chad serve: cannot write /data\..*owned by uid 1001, gid 1001'

# local-path style: a directory anyone can write, with repo/ left by another uid.
sudo mkdir -p /srv/chadt/open/repo && sudo chmod 777 /srv/chadt/open && sudo chown 0:0 /srv/chadt/open/repo
docker run -d --name chadt-open -v /srv/chadt/open:/data $IMG >/dev/null
expect "a writable volume whose repo/ belongs to another uid: refused, naming both" "$(outcome open)" 'exit 1: chad serve: /data/repo is owned by uid 0, gid 0, mode 755 and chad runs as uid 1000'
expect "and git does refuse such a repository, which is why the check exists" "$(sudo git init -q /srv/chadt/open/repo 2>&1; docker run --rm -v /srv/chadt/open:/data --entrypoint git $IMG -C /data/repo status 2>&1 | head -2)" 'dubious ownership'

docker run -d --name chadt-u2000 --user 2000:2000 -v chadt-u2000:/data $IMG >/dev/null
expect "run as another uid on a fresh volume: refused, naming that uid" "$(outcome u2000)" 'exit 1: chad serve: cannot write /data\. chad runs as uid 2000, gid 2000 and /data is owned by uid 1000, gid 1000'
note "a refused boot leaves nothing on the volume" "$(sudo ls -A /srv/chadt/other | wc -l) entries in the uid 1001 directory"
sudo rm -rf /srv/chadt ~/chadt-host
clean
