#!/usr/bin/env bash
# Fact 2: where clanka's @vscode/ripgrep dependency puts an rg binary, and whether clanka's dist refers to it
podman run --rm --name chadfacts-vsrg docker.io/library/node:26-trixie-slim bash -c '
mkdir /tmp/n && cd /tmp/n && npm init -y >/dev/null
npm install --no-audit --no-fund https://pkg.pr.new/Effect-TS/effect/effect@0b51fb1 https://pkg.pr.new/Effect-TS/effect/@effect/platform-node@0b51fb1 clanka@0.27.0 >/dev/null 2>&1
ls node_modules/@vscode; node -p "const j=require(\"./node_modules/@vscode/ripgrep/package.json\"); JSON.stringify({version:j.version,scripts:j.scripts,optionalDependencies:j.optionalDependencies,bin:j.bin})"
find node_modules -type f \( -name rg -o -name "rg.exe" \) | head; for f in $(find node_modules -type f -name rg | head -2); do ls -la $f; $f --version | head -1; done
echo "--- references in clanka dist:"; grep -rlE "vscode/ripgrep|rgPath" node_modules/clanka/dist | head -5; grep -rhoE ".{0,120}(vscode/ripgrep|rgPath).{0,160}" node_modules/clanka/dist | head -6
echo "--- ChildProcess.make calls in clanka dist:"; grep -rhoE "make\(\"(bash|rg|gh|git|sh|node)\"[^)]{0,40}|make\(rgPath[^)]{0,40}|make\([a-zA-Z]*[rR]g[a-zA-Z]*," node_modules/clanka/dist | sort | uniq -c
'
