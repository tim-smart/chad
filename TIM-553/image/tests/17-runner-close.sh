#!/usr/bin/env bash
# Run on a host with node 26, not in the image:  cd chad && pnpm install && pnpm build && bash ../tests/17-runner-close.sh
# 1. Why SingleRunner takes seconds to close when nothing is running: the daemon at different shard counts.
# 2. The volume warnings stay quiet outside a container.
cd "$(dirname "$0")/../chad"
test -f dist/daemon.js || { echo "dist/daemon.js is not built"; exit 1; }
at() { grep "\"ev\":\"$1\"" $d/out.log | tail -1 | sed 's/.*"afterMs":\([0-9]*\).*/\1/'; }
run() { # run <shards> <seconds before SIGTERM> [turn]
  d=$(mktemp -d)
  CHAD_DATA=$d CHAD_SESSION=daemon CHAD_PROTO_SHARDS=$1 node dist/daemon.js > $d/out.log 2>&1 &
  local pid=$!
  for i in $(seq 1 200); do grep -q '"phase":"ready"' $d/out.log && break; sleep 0.1; done
  if [ "$3" = turn ]; then CHAD_DATA=$d node bin/chad.js turn --session s1 --ms 300000 > /dev/null; fi
  sleep $2; kill -TERM $pid; wait $pid; local code=$?
  if [ "$3" = turn ]; then echo "$1 shards, a turn running: turn started $(grep -c turn.start $d/out.log), interrupted at $(at turn.interrupted) ms, entities closed at $(at stop.entityLayersClosed) ms, runner closed at $(at stop.runnerClosed) ms, exit $code"
  else echo "$1 shards, idle: runner closed $(( $(at stop.runnerClosed) - $(at stop.entityLayersClosed) )) ms after the entities, exit $code"; fi
  warnings=$(grep -c volume.warning $d/out.log)
  rm -rf $d
}
for n in 300 100 10 1; do for i in 1 2 3; do run $n 3; done; done
run 300 2 turn
run 1 2 turn
echo "outside a container, HOME=$HOME and CHAD_DATA under $(dirname $(mktemp -u)): $warnings volume warnings"
