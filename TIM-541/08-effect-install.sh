#!/usr/bin/env bash
# Fact 8: install effect + @effect/platform-node from the pkg.pr.new snapshot plus clanka@0.27.0, count copies of effect
IMG=docker.io/library/node:26-trixie-slim
podman run --rm --name chadfacts-effect $IMG bash -c '
set +e
SHA=0b51fb1
B=https://pkg.pr.new/Effect-TS/effect
check() { find node_modules -name package.json -path "*node_modules/effect/package.json" | while read f; do echo "$f -> $(node -p "require(\"./$f\").version")"; done
  for p in @effect/platform-node @effect/platform-node-shared @effect/ai-openai @effect/ai-openai-compat clanka; do find node_modules -name package.json -path "*node_modules/$p/package.json" | while read f; do echo "$f -> $(node -p "require(\"./$f\").version")"; done; done; }
echo "===== npm $(npm -v)"
mkdir /tmp/n && cd /tmp/n && npm init -y >/dev/null
npm install --no-audit --no-fund $B/effect@$SHA $B/@effect/platform-node@$SHA clanka@0.27.0 2>&1 | tail -15; echo "npm exit=$?"
echo "--- package.json dependencies:"; node -p "JSON.stringify(require(\"./package.json\").dependencies,null,1)"
echo "--- copies:"; check
echo "--- installed @effect/platform-node deps/peers:"; node -p "const j=require(\"./node_modules/@effect/platform-node/package.json\"); JSON.stringify({version:j.version,dependencies:j.dependencies,peerDependencies:j.peerDependencies})"
echo "--- installed effect deps:"; node -p "const j=require(\"./node_modules/effect/package.json\"); JSON.stringify({version:j.version,dependencies:j.dependencies})"
echo "--- npm ls effect:"; npm ls effect 2>&1 | head -30
du -sh node_modules
echo
echo "===== pnpm"
npm install -g --no-audit --no-fund pnpm >/dev/null 2>&1; pnpm -v
mkdir /tmp/p && cd /tmp/p && npm init -y >/dev/null
pnpm add $B/effect@$SHA $B/@effect/platform-node@$SHA clanka@0.27.0 2>&1 | tail -25; echo "pnpm exit=$?"
echo "--- package.json dependencies:"; node -p "JSON.stringify(require(\"./package.json\").dependencies,null,1)"
echo "--- copies of effect in the pnpm store dir:"; ls -d node_modules/.pnpm/effect@* 2>&1; ls -d node_modules/.pnpm/@effect+* 2>&1 | head -20
echo "--- pnpm why effect:"; pnpm why effect 2>&1 | head -40
'
