. "$(dirname "$0")/common.sh"; fresh
start_daemon B-daemon.log; wait_listening
for sig in INT KILL; do
  say "B1/$sig: long tail, then kill -$sig the cli"
  node chad.ts tail --count 100 --interval 300 & pid=$!
  sleep 1.5; echo "$(now) kill -$sig $pid"; kill -$sig $pid; wait $pid; echo "cli exit=$?"
  sleep 0.3
done
for sig in INT KILL; do
  say "B2/$sig: apply killed BEFORE commit (during load)"
  node chad.ts apply --label before-$sig --load 4000 & pid=$!
  wait_for "before-$sig.*step load" "$DLOG"; sleep 0.3
  echo "$(now) kill -$sig $pid"; kill -$sig $pid; wait $pid; echo "cli exit=$?"
  sleep 0.5
  echo "commits.log lines for before-$sig: $(grep -c "before-$sig" state/commits.log 2>/dev/null || true)"
done
for sig in INT KILL; do
  say "B3/$sig: apply killed AFTER commit (3s between commit and swap)"
  node chad.ts apply --label after-$sig --load 300 --swap-delay 3000 & pid=$!
  wait_for "commit after-$sig" state/commits.log
  echo "$(now) commit seen in commits.log; kill -$sig $pid"; kill -$sig $pid; wait $pid; echo "cli exit=$?"
  echo "$(now) commits.log right after kill:"; grep "after-$sig" state/commits.log
  sleep 3.5
  echo "$(now) commits.log 3.5s later:"; grep "after-$sig" state/commits.log
done
say "status after all of it"; node chad.ts status; echo "exit=$?"
say "daemon log"; stop_daemon; cat "$DLOG"
