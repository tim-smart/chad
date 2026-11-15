#!/usr/bin/env bash
# The launcher, and how long `chad health` takes to start.
T=bin; . "$(dirname "$0")/common.sh"
start a; wait_phase a ready || fail "the daemon did not reach ready"

expect "the launcher is a few lines of plain JavaScript" "$(x a sh -c 'grep -vc "^ *//\|^$\|^#!" /opt/chad/bin/chad.js')" '^[0-9]$'
expect "serve runs the daemon from separate files, with effect from node_modules" "$(x a sh -c 'grep -c "from \"effect/" /opt/chad/dist/daemon.js; ls -l /proc/1/exe | sed "s/.*-> //"; tr "\0" " " < /proc/1/cmdline')" '^[1-9][0-9]* .*tini'
expect "every other command runs one bundled file with no import from node_modules" "$(x a sh -c 'grep -Ec "^import .* from \"(effect|@effect|clanka)" /opt/chad/dist/cli.bundle.js; du -k /opt/chad/dist/cli.bundle.js | cut -f1')" '^0 +[0-9]+'

# 30 runs each, in the image, daemon up. Median and slowest, in ms.
times() { x a bash -c 'for i in $(seq 1 30); do s=$(date +%s%N); '"$1"' >/dev/null 2>&1; e=$(date +%s%N); echo $(( (e - s) / 1000000 )); done | sort -n | awk "{a[NR]=\$1} END {print \"median \" a[int((NR+1)/2)] \" ms, slowest \" a[NR] \" ms\"}"'; }
note "node -e 0" "$(times 'node -e 0')"
h=$(times 'chad health')
note "chad health" "$h"
note "chad status" "$(times 'chad status')"
expect "chad health answers well inside the 5 second probe timeout" "$h" 'slowest [0-9]{1,3} ms'
expect "chad health exits 0 and prints ok" "$(x a chad health; echo "exit=$?")" 'ok exit=0'
note "the same command unbundled, for scale" "$(x a bash -c 'cd /opt/chad && for i in $(seq 1 10); do s=$(date +%s%N); node dist/cli.js health >/dev/null 2>&1; e=$(date +%s%N); echo $(( (e - s) / 1000000 )); done | sort -n | sed -n 5p') ms median"
clean
