#!/usr/bin/env bash
# The stop with stdio MCP servers that ignore their stdin closing and SIGTERM.
# "The MCP layer rebuild run with calls in flight" (TIM-555) measured 4 s for each, one after another.
T=mcp-stop; . "$(dirname "$0")/common.sh"
after() { docker logs chadt-$1 2>&1 | grep "\"ev\":\"$2\"" | tail -1 | sed 's/.*"afterMs":\([0-9]*\).*/\1/'; }
# seed <name> <number of stubborn servers>
seed() {
  local json="{" i
  for i in $(seq 1 $2); do json="$json\"stubborn$i\":{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"/data/repo/work/mcp-probe.mjs\",\"stubborn\"]},"; done
  json="${json%,}}"
  docker run --rm -v chadt-$1:/data -v ~/proto/tests:/t:ro --entrypoint sh $IMG -c "mkdir -p /data/repo/work /data/state && cp /t/mcp-probe.mjs /data/repo/work/ && echo '$json' > /data/repo/work/mcp.json"
}
# stop <name> <grace>
stop() { local s=$(now_ms); docker stop -t $2 chadt-$1 >/dev/null; echo "docker stop $(( $(now_ms) - s )) ms, exit $(docker inspect chadt-$1 --format '{{.State.ExitCode}}'), entities closed at $(after $1 stop.entityLayersClosed), runner closed at $(after $1 stop.runnerClosed), process exit at $(after $1 stop.exit)"; }

for n in 1 3; do
  seed idle$n $n; start idle$n; wait_phase idle$n ready
  expect "$n stubborn server(s) connected" "$(x idle$n chad status | grep mcp | grep -o Connected | wc -l)" "^$n$"
  note "idle, $n stubborn server(s)" "$(stop idle$n 90)"
done
expect "FOUND: the close of three stubborn servers is one after another, about 4 s each, after the runner has closed" "$(( $(after idle3 stop.exit) - $(after idle3 stop.runnerClosed) )) ms from the runner's close to the exit, against $(( $(after idle1 stop.exit) - $(after idle1 stop.runnerClosed) )) ms for one" '^1[12][0-9]{3} ms from the runner.s close to the exit, against [34][0-9]{3} ms for one$'

seed par 3; start par -e CHAD_PROTO_MCP_PARALLEL=1; wait_phase par ready
expect "3 stubborn servers connected, with the layer built in a scope of chad's own that runs its finalizers at once" "$(x par chad status | grep mcp | grep -o Connected | wc -l)" "^3$"
note "idle, 3 stubborn servers, with that scope" "$(stop par 90)"
expect "FOUND: that changes nothing. clanka's layer closes its servers one after another whatever scope it is built in" "$(( $(after par stop.exit) - $(after par stop.runnerClosed) )) ms from the runner's close to the exit" '^1[12][0-9]{3} ms from'

seed busy 3; start busy; wait_phase busy ready; x busy chad turn --ms 300000 --child >/dev/null; sleep 1
r=$(stop busy 90)
expect "a turn running and three stubborn servers: 15 s for the turn, then 12 s for the servers, exit 0 inside 60 s" "$r" 'docker stop 2[6-9][0-9]{3} ms, exit 0, entities closed at 15[0-9]{3}'

seed many 12; start many -e CHAD_PROTO_STOP_MAX=60000; wait_phase many ready 200; x many chad turn --ms 300000 >/dev/null; sleep 1
r=$(stop many 90)
expect "FOUND: a turn running and twelve stubborn servers pass 60 s, and chad's own deadline is what ends it" "$r, $(docker logs chadt-many 2>&1 | grep -c stop.forced) forced, boots $(docker run --rm -v chadt-many:/data --entrypoint cat $IMG /data/state/boots)" 'docker stop 6[0-9]{4} ms, exit 1,.* 1 forced, boots 0$'
expect "the log line of that forced exit names what was still open" "$(docker logs chadt-many 2>&1 | grep stop.forced | grep -o '"stillOpen":\[[^]]*\]' | cut -c1-90)" '^"stillOpen":\["MCP servers: stubborn1, stubborn2'
clean
