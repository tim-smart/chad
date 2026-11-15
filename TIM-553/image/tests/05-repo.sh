#!/usr/bin/env bash
# What a plugin author finds under /data/repo: the type-check, the paths the self-edit skill names, the examples.
T=repo; . "$(dirname "$0")/common.sh"
start a; wait_phase a ready || fail "the daemon did not reach ready"

x a bash -c 'cd /data/repo/work && git init -q . && mkdir -p plugins && cat > tsconfig.json <<EOF
{ "compilerOptions": { "target": "es2024", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "skipLibCheck": true, "types": [] }, "include": ["plugins"] }
EOF
cat > plugins/hello.ts <<EOF
import { Plugin } from "chad"
import * as Effect from "effect/Effect"
export default Plugin.make(Plugin.background(Effect.log("hello")))
EOF'
expect "a plugin that imports chad and effect passes tsc from repo/node_modules" "$(x a bash -c 'cd /data/repo/work && /data/repo/node_modules/.bin/tsc -p . ; echo "exit=$?"')" '^exit=0'
x a bash -c 'cd /data/repo/work && cat > plugins/wrong.ts <<EOF
import { Plugin } from "chad"
export default Plugin.make(Plugin.background(42))
EOF'
expect "and a wrong one fails it, so the types are really resolved" "$(x a bash -c 'cd /data/repo/work && /data/repo/node_modules/.bin/tsc -p . ; echo "exit=$?"')" 'wrong\.ts.*TS2345.*exit=[12]'
x a rm /data/repo/work/plugins/wrong.ts
x a bash -c 'cd /data/repo/work && printf "import \"chad/Session\"\nimport \"chad/Turns\"\nimport \"chad/Plugin\"\n" > plugins/public.ts && printf "import \"chad/daemon\"\n" > plugins/private.ts'
expect "only the public modules can be imported: chad/daemon is refused, chad/Plugin, chad/Session and chad/Turns are not" "$(x a bash -c 'cd /data/repo/work && /data/repo/node_modules/.bin/tsc -p . ; echo "exit=$?"')" "^plugins/private\.ts\(1,8\): error TS(2307|2882): Cannot find module [^)]*'chad/daemon'\. exit=[12]$"
x a rm /data/repo/work/plugins/private.ts /data/repo/work/plugins/public.ts
expect "tsc loads one effect, the image's" "$(x a bash -c 'cd /data/repo/work && /data/repo/node_modules/.bin/tsc -p . --listFiles | grep "/effect/dist/Effect.d.ts"')" '^/opt/chad/node_modules/\.pnpm/effect@[^ ]*/node_modules/effect/dist/Effect\.d\.ts *$'
expect "esbuild from repo/node_modules bundles the plugin with chad and effect left outside" "$(x a bash -c 'cd /data/repo/work && /data/repo/node_modules/.bin/esbuild plugins/hello.ts --bundle --format=cjs --platform=node --packages=external --log-level=warning | grep -c "require(\"\(chad\|effect/Effect\)\")"')" '^2'

for p in /data/repo/node_modules/chad/dist/Plugin.d.ts /data/repo/node_modules/chad/dist/Session.d.ts /data/repo/node_modules/chad/dist/Turns.d.ts /data/repo/node_modules/effect/AGENTS.md /data/repo/node_modules/effect/ai-docs/src /data/logs/chad.log /data/repo/examples/cron /data/repo/examples/send-file.ts; do
  expect "the path exists: $p" "$(x a sh -c "test -e $p && echo yes || echo no")" yes
done
note "what the effect package carries besides code" "$(x a sh -c 'cd /data/repo/node_modules/effect && ls | tr "\n" " "; echo; echo "ai-docs/src files: $(find ai-docs/src -type f | wc -l)"; echo "AGENTS.md bytes: $(wc -c < AGENTS.md)"; ls ai-docs | tr "\n" " "')"
expect "the chad package carries the bundled plugins as TypeScript" "$(x a sh -c 'find /data/repo/node_modules/chad/plugins -name "*.ts" | sort | tr "\n" " "')" 'cron/index\.ts.*send-file\.ts'
expect "examples is a link into the image" "$(x a readlink /data/repo/examples)" '^/opt/chad/plugins'

expect "uid 1000 cannot write through the link into the image" "$(x a sh -c 'touch /data/repo/examples/new.ts; echo x >> /data/repo/examples/send-file.ts; rm /data/repo/examples/send-file.ts; touch /data/repo/node_modules/new; id -u')" 'Permission denied.*Permission denied.*Permission denied.*Permission denied.*1000'
expect "git status in work/ shows the plugin and neither link" "$(x a sh -c 'cd /data/repo/work && git status --porcelain --ignored | tr "\n" " "')" '^\?\? plugins/ \?\? tsconfig\.json *$'
note "uid 1000 can replace the link itself with a directory of its own" "$(x a sh -c 'rm /data/repo/examples && mkdir /data/repo/examples && echo mine > /data/repo/examples/notes.md && ls /data/repo/examples')"

# An image upgrade: the same volume under a later image.
printf 'FROM %s\nUSER root\nRUN echo "// new in v2" > /opt/chad/plugins/new-in-v2.ts\nUSER node\n' $IMG | docker build -q -t chad:proto-v2 - >/dev/null
docker rm -f chadt-a >/dev/null
docker run -d --name chadt-a -v chadt-a:/data chad:proto-v2 >/dev/null; wait_phase a ready
expect "the next boot puts the link back, and under a later image it shows that image's source" "$(x a sh -c 'readlink /data/repo/examples; ls /data/repo/examples | tr "\n" " "')" '^/opt/chad/plugins.*new-in-v2\.ts'
expect "what the agent had put at that path is moved aside, not deleted, and the move is logged" "$(x a sh -c 'cat /data/repo/examples.replaced-*/notes.md; ls /data/repo | tr "\n" " "'; ev a boot.movedAside | cut -c40-200)" '^mine examples examples\.replaced-[0-9T]+ node_modules work .*boot\.movedAside.*"path":"/data/repo/examples"'
expect "the type-check still passes on the upgraded image" "$(x a bash -c 'cd /data/repo/work && /data/repo/node_modules/.bin/tsc -p . ; echo "exit=$?"')" '^exit=0'
docker image rm -f chad:proto-v2 >/dev/null 2>&1
clean
