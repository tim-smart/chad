. "$(dirname "$0")/common.sh"; fresh
start_daemon F2-daemon.log; wait_listening
say "F2: daemon frozen in the MIDDLE of a streaming call; cli run with CHAD_PROTO_DEBUG=1"
CHAD_PROTO_DEBUG=1 node chad.ts tail --count 100 --interval 300 & pid=$!
sleep 1.5; echo "$(now) kill -STOP daemon"; kill -STOP $DPID
( sleep 25; kill -0 $pid 2>/dev/null && { echo "$(now) cli still hanging after 25s; killing it"; kill -9 $pid; } ) & w=$!
wait $pid; rc=$?; echo "$(now) cli exit=$rc"; kill $w 2>/dev/null
kill -CONT $DPID; sleep 0.3
stop_daemon
