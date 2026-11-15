. "$(dirname "$0")/common.sh"; fresh
start_daemon H-daemon.log; wait_listening
say "H0: owner, no session"; node chad.ts reload; echo "exit=$?"
say "H1: CHAD_SESSION set -> cli refuses before talking to the daemon"
CHAD_SESSION=sess-42 node chad.ts reload; echo "exit=$?"
CHAD_SESSION=sess-42 node chad.ts secret-set --secret-stdin < /dev/null; echo "exit=$?"
say "H2: non-owner command inside a session still works"
CHAD_SESSION=sess-42 node chad.ts status; echo "exit=$?"
say "H3: a cli that skips its own check but still forwards the session id -> daemon refuses"
CHAD_SESSION=sess-42 CHAD_PROTO_SKIP_LOCAL_CHECK=1 node chad.ts reload; echo "exit=$?"
say "H4: the lie: inside a session shell, the agent unsets the variable"
CHAD_SESSION=sess-42 bash -c 'echo "shell has CHAD_SESSION=$CHAD_SESSION"; env -u CHAD_SESSION node chad.ts reload; echo "exit=$?"'
say "H5: usage errors"
node chad.ts nope; echo "exit=$?"
node chad.ts tail --count abc; echo "exit=$?"
node chad.ts tail --bogus; echo "exit=$?"
say "daemon log"; stop_daemon; cat "$DLOG"
