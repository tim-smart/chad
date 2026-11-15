#!/usr/bin/env bash
# CHAD_DATA: what moves with it in this image and what does not.
T=data; . "$(dirname "$0")/common.sh"
outcome() { sleep 3; if [ "$(docker inspect chadt-$1 --format '{{.State.Running}}')" = true ]; then wait_phase $1 ready 50; echo "running, $(x $1 chad status | grep -E 'phase|data volume|warning' | tr '\n' ' ')"; else echo "exit $(docker inspect chadt-$1 --format '{{.State.ExitCode}}'): $(docker logs chadt-$1 2>&1 | tail -1)"; fi; }

docker run -d --name chadt-named -e CHAD_DATA=/srv/chad -v chadt-named:/srv/chad $IMG >/dev/null
expect "CHAD_DATA=/srv/chad on a fresh named volume is refused by the owner check: the image only owns /data, so Docker makes the volume as root" "$(outcome named)" 'exit 1: chad serve: cannot write /srv/chad\. chad runs as uid 1000, gid 1000 and /srv/chad is owned by uid 0, gid 0'

mkdir -p ~/chadt-moved && rm -rf ~/chadt-moved/*
docker run -d --name chadt-moved -e CHAD_DATA=/srv/chad -v ~/chadt-moved:/srv/chad $IMG >/dev/null
expect "CHAD_DATA=/srv/chad on a host directory owned by uid 1000: the daemon boots there, and warns for HOME, the npm prefix and the cache" "$(outcome moved)" "phase: ready data volume: ext4 \(/dev/[a-z0-9]+ at /srv/chad\) warning: HOME=/data/home is on the container's own filesystem, not on the volume at /srv/chad\..* warning: NPM_CONFIG_PREFIX=.* warning: XDG_CACHE_HOME="
expect "the layout, the socket and the links follow CHAD_DATA, and docker exec finds the daemon" "$(x moved sh -c 'ls /srv/chad | tr "\n" " "; readlink /srv/chad/repo/examples; chad health')" '^cache db home logs repo run secrets sessions state /opt/chad/plugins ok$'
expect "FOUND: HOME, the caches, the npm prefix and PATH do not follow it: they are fixed at /data by the image" "$(x moved sh -c 'echo $HOME $XDG_CACHE_HOME $NPM_CONFIG_PREFIX; echo $PATH | tr ":" "\n" | grep -c "^/data/"')" '^/data/home /data/cache /data/home/\.npm-global 2$'
x moved sh -c 'npm install -g --no-audit --no-fund cowsay >/dev/null 2>&1'
expect "FOUND: so an install lands on the container's own layer, outside the volume" "$(x moved sh -c 'command -v cowsay; ls /srv/chad/home | wc -l; findmnt -n -o FSTYPE -T /data/home 2>/dev/null || stat -f -c %T /data/home')" '^/data/home/\.npm-global/bin/cowsay 0 overlay'
docker rm -f chadt-moved >/dev/null; docker run -d --name chadt-moved -e CHAD_DATA=/srv/chad -v ~/chadt-moved:/srv/chad $IMG >/dev/null; wait_phase moved ready
expect "FOUND: and it is gone once the container is replaced" "$(x moved sh -c 'command -v cowsay || echo "cowsay not found"')" '^cowsay not found$'
x moved chad turn --session s1 --ms 1000 --child >/dev/null; sleep 1
note "the directory a session's command runs in" "$(x moved sh -c 'readlink /proc/$(cat /srv/chad/sessions/s1/child.pid)/cwd')"
rm -rf ~/chadt-moved
clean
