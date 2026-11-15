#!/usr/bin/env bash
# The stop: how long the daemon takes to exit by itself, and what the boot counter holds when the kill comes first.
T=stop; . "$(dirname "$0")/common.sh"
boots() { docker run --rm -v chadt-$1:/data --entrypoint cat $IMG /data/state/boots 2>&1; }
after() { docker logs chadt-$1 2>&1 | grep "\"ev\":\"$2\"" | tail -1 | sed 's/.*"afterMs":\([0-9]*\).*/\1/'; }
# stop <name> <grace>: prints how long docker stop took, the exit code and where the time went
stop() { local s=$(now_ms); docker stop -t $2 chadt-$1 >/dev/null; echo "docker stop $(( $(now_ms) - s )) ms, exit $(docker inspect chadt-$1 --format '{{.State.ExitCode}}'), entities closed at $(after $1 stop.entityLayersClosed), runner closed at $(after $1 stop.runnerClosed), process exit at $(after $1 stop.exit)"; }

for i in 1 2 3; do
  start idle$i; wait_phase idle$i ready; sleep $(( i * 2 ))
  r=$(stop idle$i 90)
  expect "idle, 90 second grace, run $i: the daemon exits by itself" "$r" 'exit 0, entities closed at [0-9]+, runner closed at [0-9]+, process exit at [0-9]+'
done

start busy; wait_phase busy ready; x busy chad turn --ms 300000 --child >/dev/null; sleep 1
r=$(stop busy 90)
expect "a turn running, 90 second grace: the daemon exits by itself inside 60 seconds" "$r" 'docker stop [0-9]{4,5} ms, exit 0, entities closed at 1[0-9]{4},'
expect "the counter is 0 after a stop the daemon finished" "$(boots busy)" '^0$'

start stuck; wait_phase stuck ready; x stuck chad turn --ms 300000 --mode stuck >/dev/null; sleep 1
r=$(stop stuck 90)
expect "FOUND: a turn that cannot be interrupted, 90 second grace: the daemon never exits by itself and Docker kills it at 90" "$r" 'docker stop 9[0-9]{4} ms, exit 137'
expect "the counter is still 0, because the handler cleared it" "$(boots stuck)" '^0$'

start capped -e CHAD_PROTO_STOP_MAX=60000; wait_phase capped ready; x capped chad turn --ms 300000 --mode stuck >/dev/null; sleep 1
r=$(stop capped 90)
expect "the same with a deadline of chad's own at 60 seconds: it exits at 60" "$r, $(docker logs chadt-capped 2>&1 | grep -c stop.forced) forced" 'docker stop 6[0-9]{4} ms, exit 1,.* 1 forced'

# Docker's default: 10 seconds, then SIGKILL.
start short; wait_phase short ready
for i in 1 2 3; do
  x short chad turn --ms 300000 >/dev/null; sleep 1
  s=$(now_ms); docker stop chadt-short >/dev/null; e=$(now_ms)
  expect "default docker stop with a turn running, round $i: killed at 10 seconds, and the counter is already 0" "$(( e - s )) ms, exit $(docker inspect chadt-short --format '{{.State.ExitCode}}'), boots $(boots short)" '^10[0-9]{3} ms, exit 137, boots 0$'
  docker start chadt-short >/dev/null; wait_phase short ready
done
expect "so three such restarts never add up: every boot counted 1" "$(docker logs chadt-short 2>&1 | grep boot.counted | sed 's/.*"count":\([0-9]*\).*/\1/' | tr '\n' ' ')" '^1 1 1 1$'
note "the turn the kill cut is delivered again at the next boot, by the cluster's storage" "$(docker logs chadt-short 2>&1 | grep -c turn.start) turn.start lines for 3 turns asked"

# A crash, for contrast.
start crash; wait_phase crash ready
for i in 1 2; do docker kill chadt-crash >/dev/null; docker start chadt-crash >/dev/null; wait_phase crash ready; done
expect "docker kill is counted: three boots, counted 1 2 3" "$(docker logs chadt-crash 2>&1 | grep boot.counted | sed 's/.*"count":\([0-9]*\).*/\1/' | tr '\n' ' ')" '^1 2 3$'

start clear -e CHAD_PROTO_CLEAR_MS=4000; wait_phase clear ready
expect "the counter clears a set time after the boot finished loading (4 seconds here, 60 in the design)" "$(x clear cat /data/state/boots) then $(sleep 5; x clear cat /data/state/boots)" '^1 then 0$'
clean
