. "$(dirname "$0")/common.sh"; fresh
mkdir -p ../dist
say "bundle with esbuild"
B='import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'
node_modules/.bin/esbuild chad.ts --bundle --platform=node --format=esm --target=node26 --banner:js="$B" --outfile=../dist/chad.mjs 2>&1 | tail -5
node_modules/.bin/esbuild chad.ts --bundle --minify --platform=node --format=esm --target=node26 --banner:js="$B" --outfile=../dist/chad.min.mjs 2>&1 | tail -5
ls -la ../dist/*.mjs
start_daemon I-daemon.log; wait_listening
say "bundle works against the daemon?"; node ../dist/chad.mjs health; echo "exit=$?"; node ../dist/chad.mjs status; echo "exit=$?"
say "node $(node -v), $(nproc) cpus, $(uname -m)"
node bench.mjs
stop_daemon
