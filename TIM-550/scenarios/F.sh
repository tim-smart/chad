. "$(dirname "$0")/common.sh"; fresh
start_daemon F-daemon.log; wait_listening
say "F: healthy first"; time node chad.ts health; echo "exit=$?"
say "kill -STOP $DPID, then health"
kill -STOP $DPID
time node chad.ts health; echo "exit=$?"
say "apply against the stopped daemon"
time node chad.ts apply --label f1; echo "exit=$?"
say "kill -CONT, then health"
kill -CONT $DPID; sleep 0.3
time node chad.ts health; echo "exit=$?"
say "daemon log"; stop_daemon; cat "$DLOG"
