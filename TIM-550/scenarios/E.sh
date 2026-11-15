. "$(dirname "$0")/common.sh"; fresh
start_daemon E-daemon.log; wait_listening
export CHAD_PROTO_VERSION=9.9.9
say "E: cli claims version 9.9.9, daemon is 0.1.0-proto"
for c in "health" "status" "tail --count 2" "apply --label e1 --load 100" "reload"; do
  echo "\$ node chad.ts $c"; node chad.ts $c; echo "exit=$?"
done
unset CHAD_PROTO_VERSION
say "same version"; node chad.ts apply --label e2 --load 100; echo "exit=$?"
say "commits.log"; cat state/commits.log
say "daemon log"; stop_daemon; cat "$DLOG"
