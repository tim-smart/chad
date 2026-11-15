#!/usr/bin/env bash
# Fact 4: sqlite lock + unix socket on a shared volume. usage: 04-lock.sh <label> <volume-spec-for--v>
IMG=docker.io/library/node:26-trixie-slim
S=$PWD/04-lock
LABEL=$1; VOL=$2
A=chadfacts-a; B=chadfacts-b
L=/data/state/daemon.lock
runB() { podman run --rm --name $B -v $VOL:/data -v $S:/s:ro $IMG "$@" 2>&1 | sed 's/^/   /'; }
execA() { podman exec $A "$@" 2>&1 | sed 's/^/   /'; }
echo "################ $LABEL  (-v $VOL:/data)"
podman rm -f -t 0 $A $B >/dev/null 2>&1
podman run -d --name $A -v $VOL:/data -v $S:/s:ro $IMG sh -c "mkdir -p /data/state /data/run && exec node /s/hold.mjs $L hold" >/dev/null
sleep 1
echo "A logs: $(podman logs $A 2>&1)"
echo "A fs of /data: $(podman exec $A sh -c 'df -T /data | tail -1; grep " /data " /proc/self/mountinfo | cut -d" " -f 4-11' | tr '\n' ' ')"
echo "A /proc/locks: $(podman exec $A sh -c 'cat /proc/locks' | tr '\n' ';')"
echo "1. B (second container, same volume) hold.mjs -> expect REFUSED:"; runB node /s/hold.mjs $L
echo "2. B test.mjs -> expect held:"; runB node /s/test.mjs $L
echo "3. podman exec in A hold.mjs -> expect REFUSED:"; execA node /s/hold.mjs $L
echo "4. podman exec in A test.mjs -> expect held:"; execA node /s/test.mjs $L
echo "5. podman kill A (SIGKILL)"; podman kill $A >/dev/null; sleep 0.5; echo "   A state: $(podman inspect $A --format '{{.State.Status}} exit={{.State.ExitCode}}')"
echo "6. B test.mjs after kill -> expect free:"; runB node /s/test.mjs $L
echo "7. B hold.mjs after kill -> expect HELD:"; runB node /s/hold.mjs $L
echo "   files: $(podman run --rm --name $B -v $VOL:/data $IMG sh -c 'ls -la /data/state | tail -n +2 | tr "\n" ";"')"
podman rm -f -t 0 $A >/dev/null 2>&1

echo "---- unix socket /data/run/chad.sock"
podman run -d --name $A -v $VOL:/data -v $S:/s:ro $IMG node /s/server.mjs /data/run/chad.sock >/dev/null
sleep 1
echo "A logs: $(podman logs $A 2>&1)"
echo "8. client via podman exec in A:"; execA node /s/client.mjs /data/run/chad.sock
echo "9. client from container B (same volume, separate network namespace):"; runB node /s/client.mjs /data/run/chad.sock
echo "10. client from container B as uid 1000 (--user node):"; podman run --rm --name $B --user node -v $VOL:/data -v $S:/s:ro $IMG node /s/client.mjs /data/run/chad.sock 2>&1 | sed 's/^/   /'
echo "11. podman kill A, then socket file left behind?"; podman kill $A >/dev/null; sleep 0.5
runB sh -c 'ls -la /data/run | tail -n +2; node /s/client.mjs /data/run/chad.sock'
echo "12. new server on the stale path without unlink:"; runB node /s/server.mjs /data/run/chad.sock & sleep 2; podman rm -f -t 0 $B >/dev/null 2>&1; wait
echo "13. new server on the stale path with unlink first:"; podman rm -f -t 0 $A >/dev/null 2>&1
podman run -d --name $A -v $VOL:/data -v $S:/s:ro $IMG node /s/server.mjs /data/run/chad.sock unlink >/dev/null; sleep 1; echo "   $(podman logs $A 2>&1)"; execA node /s/client.mjs /data/run/chad.sock
podman rm -f -t 0 $A $B >/dev/null 2>&1
