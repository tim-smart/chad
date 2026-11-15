#!/usr/bin/env bash
# The image's HEALTHCHECK against a frozen daemon. Uses the image's own numbers, so it takes about two minutes.
T=health; . "$(dirname "$0")/common.sh"
start a --restart unless-stopped; wait_phase a ready
for i in $(seq 1 40); do [ "$(docker inspect chadt-a --format '{{.State.Health.Status}}')" = healthy ] && break; sleep 0.5; done
expect "healthy once the daemon answers" "$(docker inspect chadt-a --format '{{.State.Health.Status}}')" '^healthy$'
x a sh -c 'kill -STOP $(pgrep -P 1)'
s=$(now_ms)
expect "chad health against a frozen daemon: exit 1 after its own 2 seconds" "$(a=$(now_ms); x a chad health; echo "exit=$? in $(( $(now_ms) - a )) ms")" 'no answer on /data/run/chad\.sock in 2 seconds exit=1 in 2[0-9]{3} ms'
h=""; for i in $(seq 1 100); do h=$(docker inspect chadt-a --format '{{.State.Health.Status}}'); [ "$h" = unhealthy ] && break; sleep 2; done
expect "Docker reports the frozen daemon unhealthy" "$h $(( ($(now_ms) - s) / 1000 )) s after SIGSTOP, failing streak $(docker inspect chadt-a --format '{{.State.Health.FailingStreak}}')" '^unhealthy [0-9]+ s'
sleep 20
expect "nothing restarts it, even with a restart policy" "running=$(docker inspect chadt-a --format '{{.State.Running}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}')" 'running=true restarts=0 policy=unless-stopped'
s=$(now_ms); docker stop -t 5 chadt-a >/dev/null
expect "stopping it: SIGTERM cannot run the handler, so the kill of a frozen daemon is counted as unclean" "$(( $(now_ms) - s )) ms, exit $(docker inspect chadt-a --format '{{.State.ExitCode}}'), boots $(docker run --rm -v chadt-a:/data --entrypoint cat $IMG /data/state/boots)" '^5[0-9]{3} ms, exit 137, boots 1$'
clean
