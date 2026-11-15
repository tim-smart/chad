#!/usr/bin/env bash
# The idle stop at 300 shards (cluster's default) and at 1, in the container, with every CPU of the engine busy.
T=shards; . "$(dirname "$0")/common.sh"
after() { docker logs chadt-$1 2>&1 | grep "\"ev\":\"$2\"" | tail -1 | sed 's/.*"afterMs":\([0-9]*\).*/\1/'; }
close() { echo $(( $(after $1 stop.runnerClosed) - $(after $1 stop.entityLayersClosed) )); }
docker run -d --name chadt-load --entrypoint sh $IMG -c "for i in \$(seq 1 $(( $(nproc) * 3 ))); do (while :; do :; done) & done; wait" >/dev/null
sleep 20
for n in 300 1; do
  out=""
  for i in 1 2 3; do
    start s$n-$i -e CHAD_PROTO_SHARDS=$n; wait_phase s$n-$i ready 200; sleep 3
    docker stop -t 90 chadt-s$n-$i >/dev/null
    out="$out $(close s$n-$i)"
  done
  if [ $n = 1 ]; then expect "under load, 1 shard: the runner closes in milliseconds, three runs" "ms after the entities:$out" '^ms after the entities:( [0-9]{1,2}){3}$'
  else note "under load, 300 shards: ms from the entities' close to the runner's, three runs" "$out"; fi
done
note "load on the engine while those six ran" "$(( $(nproc) * 3 )) busy loops on $(nproc) CPUs, load average $(cut -d' ' -f1-3 /proc/loadavg)"
docker rm -f chadt-load >/dev/null
start turn1 -e CHAD_PROTO_SHARDS=1; wait_phase turn1 ready 200; x turn1 chad turn --ms 300000 --child >/dev/null; sleep 1
docker stop -t 90 chadt-turn1 >/dev/null
expect "1 shard, a turn running: the turn started, was interrupted at 15 s and the daemon exited 0" "turn.start $(docker logs chadt-turn1 2>&1 | grep -c turn.start), entities closed at $(after turn1 stop.entityLayersClosed), exit $(docker inspect chadt-turn1 --format '{{.State.ExitCode}}')" '^turn.start 1, entities closed at 15[0-9]{3}, exit 0$'
clean
