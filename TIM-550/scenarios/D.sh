. "$(dirname "$0")/common.sh"; fresh
say "D1: no daemon, no state dir"
node chad.ts status; echo "exit=$?"; node chad.ts apply --label d0; echo "exit=$?"
echo "state dir exists after those calls? $(test -e state && echo yes || echo no)"
say "D2: daemon takes the lock, waits 5s before listening"
start_daemon D-daemon.log --listen-delay 5000
wait_for "lock taken" "$DLOG"; sleep 0.3
echo "--- state before cli:"; ls -la --time-style=full-iso state; find state -type f -exec md5sum {} +
echo "$(now) running: node chad.ts apply --label d1"
time node chad.ts apply --label d1; echo "exit=$?"
echo "$(now) running: node chad.ts health"
node chad.ts health; echo "exit=$?"
echo "--- state after cli:"; ls -la --time-style=full-iso state; find state -type f -exec md5sum {} +
wait_listening; echo "$(now) daemon listening now"; node chad.ts health; echo "exit=$?"
say "D3: second daemon while the first runs"
node chad.ts serve; echo "second daemon exit=$?"
say "D4: kill -9 the daemon; socket file stays"
kill -9 $DPID; wait $DPID 2>/dev/null; ls -la state
node chad.ts status; echo "exit=$?"
say "D5a: new daemon WITHOUT unlinking the stale socket (what NodeSocketServer does on its own)"
CHAD_PROTO_DEBUG=1 timeout 5 node chad.ts serve --keep-stale-socket 2>&1 | grep -v "^ *at " | head -12
say "D5b: new daemon that unlinks the stale socket after taking the lock"
start_daemon D-daemon2.log; wait_listening; cat "$DLOG"; node chad.ts health; echo "exit=$?"
stop_daemon
say "first daemon log"; cat $LOGS/D-daemon.log
