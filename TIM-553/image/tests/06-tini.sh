#!/usr/bin/env bash
# tini as the entrypoint: who gets SIGTERM, and who reaps orphans.
T=tini; . "$(dirname "$0")/common.sh"
MCP='{"probe":{"type":"stdio","command":"node","args":["/data/repo/work/mcp-probe.mjs"]}}'
# seed <name>: a volume that already holds mcp.json and the probe server
seed() {
  docker run --rm -v chadt-$1:/data -v ~/proto/tests:/t:ro --entrypoint sh $IMG -c "mkdir -p /data/repo/work /data/state && cp /t/mcp-probe.mjs /data/repo/work/ && echo '$MCP' > /data/repo/work/mcp.json"
}

seed a; start a; wait_phase a ready || fail "the daemon did not reach ready"
expect "PID 1 is tini and chad is its only child" "$(x a sh -c 'ps -o pid,ppid,comm -e | awk "\$1==1 || \$2==1" | tr -s " "')" '1 0 tini.* [0-9]+ 1 (node|MainThread|chad)'
expect "the MCP server connected through clanka's layer" "$(x a chad status | grep mcp)" 'probe Connected'
x a chad turn --session s1 --ms 300000 --child >/dev/null; sleep 1.5
note "process groups: the daemon, the MCP server, the session's background command" "$(x a sh -c 'ps -o pid,ppid,pgid,args -e | grep -v "ps -o" | cut -c1-90' | grep -E 'tini|chad|mcp-probe|child.pid')"

s=$(now_ms); docker stop -t 90 chadt-a >/dev/null; e=$(now_ms)
term=$(ev_ms a stop.sigterm)
child=$(docker run --rm -v chadt-a:/data --entrypoint cat $IMG /data/sessions/s1/child.term 2>&1)
mcp=$(docker run --rm -v chadt-a:/data --entrypoint sh $IMG -c 'ls /data/state | grep mcp-server | tr "\n" " "; cat /data/state/mcp-server.exit' 2>&1)
expect "SIGTERM reached the daemon" "$(ev a stop.sigterm)" 'stop.sigterm'
note "ms from docker stop to the daemon's handler" "$(( term - s ))"
expect "the session's background command got its signal from chad, later, and not from tini" "background command signalled $(( child - term )) ms after the daemon" 'signalled [0-9]{4,} ms'
expect "the MCP server was not signalled at all: it ended when chad closed its stdin, after the entities" "$(echo "$mcp" | sed 's/ [0-9]*$//') ended $(( $(echo "$mcp" | awk '{print $NF}') - term )) ms after the daemon's SIGTERM" '^mcp-server\.env mcp-server\.exit ended [0-9]{4,} ms'
note "docker stop took, ms, and the exit code" "$(( e - s )) ms, exit $(docker inspect chadt-a --format '{{.State.ExitCode}}')"

# Orphans. A process whose parent has gone is handed to PID 1.
docker rm -f chadt-a >/dev/null; start a; wait_phase a ready
x a sh -c '(sleep 1 &)'; sleep 2.5
refute "with tini, an orphan that exits is reaped" "$(x a sh -c 'ps -o pid,ppid,stat,comm -e' | grep -c ' Z')" '^[1-9]'
docker run -d --name chadt-noinit -v chadt-noinit:/data --entrypoint /usr/local/bin/chad $IMG serve >/dev/null; wait_phase noinit ready
x noinit sh -c '(sleep 1 &)'; sleep 2.5
expect "without it, the same orphan stays as a zombie under node" "$(x noinit sh -c 'ps -o pid,ppid,stat,comm -e' | grep ' Z')" 'Z.*sleep'

# The same stop under tini -g, which signals the whole process group.
docker rm -f chadt-a >/dev/null; docker volume rm -f chadt-a >/dev/null
seed a; docker run -d --name chadt-a -v chadt-a:/data --entrypoint /usr/bin/tini $IMG -g -- /usr/local/bin/chad serve >/dev/null; wait_phase a ready
x a chad turn --session s1 --ms 300000 --child >/dev/null; sleep 1.5
docker stop -t 90 chadt-a >/dev/null
term=$(ev_ms a stop.sigterm)
mcp=$(docker run --rm -v chadt-a:/data --entrypoint cat $IMG /data/state/mcp-server.term 2>&1)
child=$(docker run --rm -v chadt-a:/data --entrypoint cat $IMG /data/sessions/s1/child.term 2>&1)
expect "under tini -g the MCP server is signalled at the same moment as the daemon" "MCP server signalled $(( mcp - term )) ms after the daemon" 'signalled -?[0-9]{1,2} ms'
note "under tini -g the session's background command, which has its own process group" "signalled $(( child - term )) ms after the daemon"
clean
