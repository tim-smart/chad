#!/usr/bin/env bash
# Fact 8, second pass: where npm resolved each @effect package from, size breakdown, and pnpm with blockExoticSubdeps off
IMG=docker.io/library/node:26-trixie-slim
podman run --rm --name chadfacts-effect $IMG bash -c '
set +e
SHA=0b51fb1
B=https://pkg.pr.new/Effect-TS/effect
echo "===== npm: resolved URLs from package-lock.json"
mkdir /tmp/n && cd /tmp/n && npm init -y >/dev/null
npm install --no-audit --no-fund $B/effect@$SHA $B/@effect/platform-node@$SHA clanka@0.27.0 >/dev/null 2>&1
node -e "const l=require(\"./package-lock.json\").packages; for (const k of Object.keys(l)) if (/node_modules\/(effect|@effect\/[^/]+|clanka|dfx)$/.test(k)) console.log(k, l[k].version, l[k].resolved, l[k].peer?\"(peer)\":\"\")"
echo "--- biggest packages:"; du -sm node_modules/* node_modules/@*/* 2>/dev/null | sort -n | tail -8
echo "--- npm view versions on the registry:"; for p in effect @effect/platform-node @effect/ai-openai @effect/chat-discord @effect/chat-slack @effect/sql-sqlite-node dfx clanka; do echo "$p latest=$(npm view $p version 2>&1 | tail -1)"; done
echo
echo "===== pnpm with blockExoticSubdeps=false"
npm install -g --no-audit --no-fund pnpm >/dev/null 2>&1; pnpm -v
mkdir /tmp/p && cd /tmp/p && npm init -y >/dev/null
printf "blockExoticSubdeps: false\n" > pnpm-workspace.yaml
pnpm add $B/effect@$SHA $B/@effect/platform-node@$SHA clanka@0.27.0 2>&1 | grep -vE "^Progress|Downloading" | tail -25; echo "pnpm exit=${PIPESTATUS[0]}"
echo "--- package.json dependencies:"; node -p "JSON.stringify(require(\"./package.json\").dependencies,null,1)"
echo "--- copies of effect / @effect in node_modules/.pnpm:"; ls -d node_modules/.pnpm/effect@* node_modules/.pnpm/@effect+* 2>&1 | cut -c1-200
echo "--- find:"; find node_modules -name package.json -path "*node_modules/effect/package.json" | cut -c1-200
echo "--- pnpm-workspace.yaml after add:"; cat pnpm-workspace.yaml
echo
echo "===== pnpm, same but also with the chat + sqlite packages and an overrides block"
mkdir /tmp/q && cd /tmp/q && npm init -y >/dev/null
cat > pnpm-workspace.yaml <<EOF
blockExoticSubdeps: false
overrides:
  effect: $B/effect@$SHA
EOF
pnpm add $B/effect@$SHA $B/@effect/platform-node@$SHA $B/@effect/sql-sqlite-node@$SHA $B/@effect/chat-discord@$SHA $B/@effect/chat-slack@$SHA dfx clanka@0.27.0 2>&1 | grep -vE "^Progress|Downloading" | tail -25; echo "pnpm exit=${PIPESTATUS[0]}"
ls -d node_modules/.pnpm/effect@* node_modules/.pnpm/@effect+* node_modules/.pnpm/dfx@* 2>&1 | cut -c1-200
'
