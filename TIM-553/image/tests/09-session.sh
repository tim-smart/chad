#!/usr/bin/env bash
# CHAD_SESSION: set by chad serve, inherited by what the daemon starts, absent from docker exec.
T=session; . "$(dirname "$0")/common.sh"
MCP='{"probe":{"type":"stdio","command":"node","args":["/data/repo/work/mcp-probe.mjs"]}}'
docker run --rm -v chadt-a:/data -v ~/proto/tests:/t:ro --entrypoint sh $IMG -c "mkdir -p /data/repo/work /data/state && cp /t/mcp-probe.mjs /data/repo/work/ && echo '$MCP' > /data/repo/work/mcp.json"
start a -e CHAD_PROTO_OWNER_TZ=Pacific/Auckland; wait_phase a ready || fail "the daemon did not reach ready"

refute "the image does not set it" "$(docker image inspect $IMG --format '{{.Config.Env}}')" 'CHAD_SESSION'
expect "chad serve sets it to daemon in its own process" "$(ev a boot.counted)" '"session":"daemon"'
expect "a stdio MCP server started by clanka's layer has it" "$(x a cat /data/state/mcp-server.env | head -1)" '^CHAD_SESSION=daemon$'
expect "and so does a child of that server" "$(x a cat /data/state/mcp-child.env)" '^CHAD_SESSION=daemon$'
x a chad turn --session s7 --ms 2000 --child >/dev/null; sleep 1
expect "a session's command has the session id" "$(x a cat /data/sessions/s7/child.env)" '^CHAD_SESSION=s7$'
expect "a session's command has TZ set to the owner's timezone, and the daemon itself does not" "$(x a cat /data/sessions/s7/child.tz); daemon: $(x a sh -c 'tr "\0" "\n" < /proc/1/environ | grep -c "^TZ="')" '^TZ=Pacific/Auckland NZ[SD]T; daemon: 0$'
note "what the image has for timezones" "$(x a sh -c 'ls /usr/share/zoneinfo 2>&1 | wc -l; TZ=Pacific/Auckland date +%Z; TZ=Pacific/Auckland node -e "console.log(new Date().toString().slice(25))"')"
expect "a docker exec shell does not have it" "$(x a sh -c 'echo ${CHAD_SESSION:-unset}'; docker exec -t chadt-a sh -c 'echo ${CHAD_SESSION:-unset}' 2>&1 | tr -d '\r')" '^unset unset$'
note "docker exec -e can set it, which is why the daemon's own refusal was dropped in TIM-550" "$(docker exec -e CHAD_SESSION=daemon chadt-a sh -c 'echo $CHAD_SESSION')"
clean
