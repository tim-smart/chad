#!/usr/bin/env bash
# The boot order: the socket answers before the database is open, and a second daemon is refused.
T=boot; . "$(dirname "$0")/common.sh"
s=$(now_ms)
start a -e CHAD_PROTO_DB_DELAY=8000
first=""; for i in $(seq 1 100); do o=$(x a chad status); if echo "$o" | grep -q phase; then first=$(( $(now_ms) - s )); break; fi; sleep 0.05; done
expect "chad status answers during boot and names the phase" "$o" 'phase: database'
note "ms from docker run to the first answer" "$first"
note "ms from the container's start to the socket listening" "$(( $(ev_ms a boot.phase) - $(date -d "$(docker inspect chadt-a --format '{{.State.StartedAt}}')" +%s%3N) ))"
expect "chad health passes while the database is still opening" "$(x a chad health; echo "exit=$?")" 'ok exit=0'
expect "a turn asked for during boot is not started" "$(x a chad turn --ms 100)" 'not ready: database'
h=""; for i in $(seq 1 30); do h=$(docker inspect chadt-a --format '{{.State.Health.Status}}'); [ "$h" = healthy ] && break; sleep 0.25; done
expect "Docker marks the container healthy during that phase, on the 2 second start interval" "$h after $(( $(now_ms) - s )) ms, $(x a chad status | grep phase)" '^healthy after [0-9]{3,4} ms, phase: database'

# A second daemon on the same volume.
before=$(x a cat /data/state/boots)
out=$(docker run --rm --name chadt-b -v chadt-a:/data $IMG 2>&1; echo "exit=$?")
expect "a second chad serve on the volume is refused the lock and exits 1" "$out" 'another chad serve holds the lock on /data.*exit=1'
expect "that boot is not counted, and the first daemon still answers" "boots $before then $(x a cat /data/state/boots), $(x a chad health)" '^boots 1 then 1, ok'
wait_phase a ready 80

# The lock again, with garbage collected every 200 ms. The first two full runs passed the check above by luck:
# nothing referred to the lock's handle, and in the third run a collection released it and a second daemon got in.
probe() { docker cp ~/proto/tests/lock-probe.cjs chadt-$1:/tmp/lock-probe.cjs >/dev/null; x $1 node /tmp/lock-probe.cjs 2>&1 | grep -o 'lock is [A-Z]*'; }
start gc -e CHAD_PROTO_GC_MS=200; wait_phase gc ready 80; sleep 3
out=$(timeout 20 docker run --rm --name chadt-gc2 -v chadt-gc:/data $IMG 2>&1 | tail -1; echo "exit=${PIPESTATUS[0]}")
expect "with garbage collected five times a second the daemon still holds the lock, and a second serve is refused" "$(probe gc), $out" '^lock is HELD, .*another chad serve holds the lock on /data.*exit=1$'
start hole -e CHAD_PROTO_GC_MS=200 -e CHAD_PROTO_NO_LOCK_REF=1; wait_phase hole ready 80; sleep 3
expect "FOUND: the same daemon with nothing referring to the lock's handle has lost the lock. It still answers chad status, and chad health fails because it tests the lock" "$(probe hole), $(x hole chad status | grep phase), $(x hole chad health 2>&1; echo "exit=$?")" '^lock is FREE, phase: ready, chad health: nothing holds the lock on /data\..* exit=1$'
docker rm -f chadt-gc2 >/dev/null 2>&1
expect "the first daemon reaches ready after the 8 seconds" "$(x a chad status | grep phase)" 'phase: ready'
expect "state/version is written" "$(x a cat /data/state/version)" '^0\.0\.0-proto'
expect "the daemon's log is on the volume as JSON lines" "$(x a sh -c 'head -1 /data/logs/chad.log | jq -r .ev; wc -l < /data/logs/chad.log')" '^boot\.counted [0-9]+'
clean
