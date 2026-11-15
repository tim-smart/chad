. "$(dirname "$0")/common.sh"; fresh
start_daemon A-daemon.log; wait_listening
say "A: stream of lines over the unix socket; cli prefix = time received, payload = time sent"
node chad.ts tail --count 5 --interval 400; echo "exit=$?"
say "ls -la state"; ls -la state
say "daemon log"; stop_daemon; cat "$DLOG"
say "after SIGTERM: ls -la state"; ls -la state
