# cli-proto: throwaway prototype for the chad daemon/CLI design

Run everything from this directory. Logs land in `logs/`, one per scenario.

    bash scenarios/all.sh A B C D D6 E F F2 H I J K     # daemon/CLI scenarios
    (cd app && node g-clanka.ts  > ../logs/G-executor.log 2>&1)   # claim G (i)-(v), (vii)
    (cd app && node g-subagent.ts > ../logs/G-subagent.log 2>&1)  # claim G (vi)

## app/
- `chad.ts` — the one program. `serve` is the daemon; `health`, `status`, `tail`, `apply`, `reload`, `secret-set`, `secret-raw` are clients (effect/cli Command).
- `rpcs.ts` — the RPC group (Ping, Status, Tail, Apply, Reload) and the version string.
- `session-spawner.ts` — the ChildProcessSpawner wrap that adds CHAD_SESSION (modes: extend, naive-setEnv).
- `g-clanka.ts` — real clanka AgentExecutor.layerLocal with the wrapped spawner; bash, background bash, rg, gh, two sessions.
- `g-subagent.ts` — real clanka Agent loop with a scripted LanguageModel; root agent starts a sub-agent that runs bash.
- `bench.mjs`, `empty.mjs` — startup timing (claim I).
- `peercred-probe.mjs` — shows node:net exposes no peer pid/uid for a unix socket (claim H).
- `flag-probe.ts` — a bare `Flag.Boolean` with no default, run with and without the flag.
- `state/` — daemon.lock, chad.sock, commits.log of the last scenario run.

## scenarios/
- `common.sh` — helpers (start_daemon, wait_listening, fresh).
- `A.sh` streaming; `B.sh` client killed mid-call and the apply rule; `C.sh` queue; `D.sh` lock next to socket, stale socket; `D6.sh` lock test after a crash; `E.sh` version; `F.sh` health vs SIGSTOP; `F2.sh` daemon frozen mid-stream; `H.sh` owner refusal and usage errors; `I.sh` bundle + timing; `J.sh` secrets; `K.sh` SIGTERM to the daemon between commit and swap.
- `all.sh <names>` — runs the named scenarios, writing `logs/<name>.log`.

## Test-only environment switches in chad.ts
- `CHAD_PROTO_VERSION` — version the client claims (claim E).
- `CHAD_PROTO_SKIP_LOCAL_CHECK=1` — skip the CLI-side owner check but still forward the session id (claim H).
- `CHAD_PROTO_ABS_SOCKET=1` — bind the absolute socket path even when longer than 107 bytes (shows listen EINVAL).
- `CHAD_PROTO_DEBUG=1` — print the failure and exit bookkeeping.

## dist/
- `chad.mjs`, `chad.min.mjs` — esbuild bundles; `cc-*` — NODE_COMPILE_CACHE directories.
