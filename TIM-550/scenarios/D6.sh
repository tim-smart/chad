. "$(dirname "$0")/common.sh"; fresh
start_daemon D6-daemon.log; wait_listening
say "D6: kill -9 the daemon, then does the cli's lock test (BEGIN IMMEDIATE; ROLLBACK) change files?"
kill -9 $DPID; wait $DPID 2>/dev/null
echo "--- before cli:"; ls -la --time-style=full-iso state | tail -n +4; md5sum state/daemon.lock*
node chad.ts status; echo "exit=$?"
echo "--- after cli:"; ls -la --time-style=full-iso state | tail -n +4; md5sum state/daemon.lock*
