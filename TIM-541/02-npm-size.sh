#!/usr/bin/env bash
# Fact 2: what esbuild and typescript@7 add (npm install into temp dirs inside the slim image, then du)
podman run --rm --name chadfacts-npmsize docker.io/library/node:26-trixie-slim bash -c '
set -e
for p in esbuild typescript@7 "esbuild typescript@7"; do
  d=$(mktemp -d); cd $d; npm init -y >/dev/null
  npm install --no-audit --no-fund $p >/dev/null 2>&1
  echo "== npm install $p"
  du -sh node_modules | cut -f1
  du -sh node_modules/* node_modules/@*/* 2>/dev/null | sort -h | tail -6
  node -e "for (const n of [\"esbuild\",\"typescript\"]) { try { console.log(n, require(\"./node_modules/\"+n+\"/package.json\").version) } catch {} }"
  ls node_modules/.bin
done
npm view typescript dist-tags --json
'
