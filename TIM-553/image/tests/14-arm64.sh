#!/usr/bin/env bash
# The arm64 image, run under QEMU user emulation. It shows the image is complete for arm64; the times mean nothing.
T=arm64; . "$(dirname "$0")/common.sh"
IMG=chad:proto-arm64
docker image inspect $IMG >/dev/null 2>&1 || { fail "chad:proto-arm64 is not built"; exit 0; }
expect "the image is arm64" "$(docker image inspect $IMG --format '{{.Os}}/{{.Architecture}}')" '^linux/arm64$'
start a; wait_phase a ready 600 || fail "the daemon did not reach ready"
expect "the daemon boots to ready on arm64" "$(x a sh -c 'uname -m; chad status | grep phase')" '^aarch64 phase: ready'
expect "chad health answers" "$(x a chad health; echo "exit=$?")" 'ok exit=0'
expect "the arm64 builds of the native parts are the ones installed" "$(x a sh -c 'ls /opt/chad/node_modules/.pnpm | grep -E "^@(esbuild|typescript)\+.*(arm64|x64)" | tr "\n" " "')" '^@esbuild\+linux-arm64@[^ ]+ @typescript\+typescript-linux-arm64@[^ ]+$'
x a bash -c 'cd /data/repo/work && mkdir -p plugins && cat > tsconfig.json <<EOF
{ "compilerOptions": { "target": "es2024", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "skipLibCheck": true, "types": [] }, "include": ["plugins"] }
EOF
cat > plugins/hello.ts <<EOF
import { Plugin } from "chad"
import * as Effect from "effect/Effect"
export default Plugin.make(Plugin.background(Effect.log("hello")))
EOF'
expect "tsc and esbuild run on arm64" "$(x a bash -c 'cd /data/repo/work && /data/repo/node_modules/.bin/tsc -p . ; echo "tsc=$?"; /data/repo/node_modules/.bin/esbuild plugins/hello.ts --bundle --format=cjs --platform=node --packages=external --log-level=warning >/dev/null; echo "esbuild=$?"')" '^tsc=0 esbuild=0'
expect "git, rg, gh, sqlite3 and uv run on arm64" "$(x a sh -c 'git --version >/dev/null && rg --version >/dev/null && gh --version >/dev/null && sqlite3 --version >/dev/null && uv --version >/dev/null; echo "exit=$?"')" '^exit=0'
x a chad turn --ms 300000 --child >/dev/null; sleep 3
s=$(now_ms); docker stop -t 90 chadt-a >/dev/null
note "docker stop with a turn running, under emulation" "$(( $(now_ms) - s )) ms, exit $(docker inspect chadt-a --format '{{.State.ExitCode}}')"
clean
