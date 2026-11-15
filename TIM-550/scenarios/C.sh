. "$(dirname "$0")/common.sh"; fresh
start_daemon C-daemon.log; wait_listening
say "C1: slow apply c1, then c2 from another cli process"
node chad.ts apply --label c1 --load 3000 & p1=$!
wait_for 'c1.*step load' "$DLOG"
node chad.ts apply --label c2 --load 300 & p2=$!
wait $p1; echo "c1 exit=$?"; wait $p2; echo "c2 exit=$?"
say "C2: c3 slow, c4 waits, kill -9 c3 while c4 waits"
node chad.ts apply --label c3 --load 8000 & p3=$!
wait_for 'c3.*step load' "$DLOG"
node chad.ts apply --label c4 --load 300 & p4=$!
wait_for 'c4.*queued' "$DLOG"; sleep 0.5
echo "$(now) kill -9 $p3 (c3)"; kill -9 $p3; wait $p3; echo "c3 exit=$?"
wait $p4; rc=$?; echo "$(now) c4 exit=$rc"
say "commits.log"; cat state/commits.log
say "daemon log"; stop_daemon; cat "$DLOG"
