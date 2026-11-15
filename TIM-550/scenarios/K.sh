. "$(dirname "$0")/common.sh"; fresh
start_daemon K-daemon.log; wait_listening
say "K (extra, not in the claim list): SIGTERM to the DAEMON between commit and swap"
node chad.ts apply --label k1 --load 300 --swap-delay 3000 & pid=$!
wait_for "commit k1" state/commits.log
echo "$(now) commit seen; kill -TERM daemon $DPID"; kill -TERM $DPID
wait $DPID; rc=$?; echo "$(now) daemon exit=$rc"
wait $pid; rc=$?; echo "$(now) cli exit=$rc"
say "commits.log"; cat state/commits.log
say "ls state"; ls -la state
say "daemon log"; grep -v "^ *at " "$DLOG"
