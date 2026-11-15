#!/usr/bin/env bash
# Fact 2: what a spawn of a missing binary looks like through effect's Node ChildProcessSpawner, in the stock slim image (no rg/gh/git)
# and whether clanka's @vscode/ripgrep dependency puts an rg on PATH
IMG=docker.io/library/node:26-trixie-slim
podman run --rm --name chadfacts-missing -v $PWD/02-missing-binary:/s:ro $IMG bash -c '
mkdir /tmp/n && cd /tmp/n && npm init -y >/dev/null
npm install --no-audit --no-fund https://pkg.pr.new/Effect-TS/effect/effect@0b51fb1 https://pkg.pr.new/Effect-TS/effect/@effect/platform-node@0b51fb1 clanka@0.27.0 >/dev/null 2>&1
cp /s/spawn.mjs . && node spawn.mjs
echo "--- @vscode/ripgrep after npm install:"; ls -la node_modules/@vscode/ripgrep/bin 2>&1 | tail -3; ls node_modules/.bin | tr "\n" " "; echo
echo "--- rg on PATH? $(command -v rg || echo no)"
grep -rn "vscode/ripgrep" node_modules/clanka/dist --include=*.mjs -l 2>/dev/null | head -3; grep -rhoE ".{80}rgPath.{80}" node_modules/clanka/dist 2>/dev/null | head -3
'
