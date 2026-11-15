# shared helpers; every scenario runs from app/ and uses app/state
cd "$(dirname "${BASH_SOURCE[0]}")/../app" || exit 1
LOGS=../logs
# always call `node chad.ts` directly: a shell function run with & is a subshell and $! is not the node pid
say() { echo; echo "### $*"; }
now() { date +%H:%M:%S.%3N; }
start_daemon() { # $1 = daemon log file name, rest = serve flags
  DLOG=$LOGS/$1; shift
  node chad.ts serve "$@" > "$DLOG" 2>&1 &
  DPID=$!
}
wait_listening() { for i in $(seq 150); do grep -q "listening on" "$DLOG" && return 0; sleep 0.1; done; echo "daemon never listened"; return 1; }
stop_daemon() { kill "$DPID" 2>/dev/null; wait "$DPID" 2>/dev/null; }
wait_for() { for i in $(seq 100); do grep -q "$1" "$2" 2>/dev/null && return 0; sleep 0.05; done; echo "never saw $1 in $2"; return 1; }
fresh() { pkill -f "chad.ts serve" 2>/dev/null; sleep 0.2; rm -rf state; }
