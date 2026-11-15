#!/usr/bin/env bash
# The tools in the image and what it weighs.
T=size; . "$(dirname "$0")/common.sh"
run() { docker run --rm --user 0 --entrypoint bash $IMG -c "$1" 2>&1; }

v=$(run 'for c in "node -v" "git --version" "rg --version" "gh --version" "sqlite3 --version" "curl --version" "jq --version" "ps --version" "ssh -V" "unzip -v" "xz --version" "tini --version" "uv --version" "/opt/chad/node_modules/.bin/tsc -v" "/opt/chad/node_modules/.bin/esbuild --version"; do printf "%s => " "$c"; $c 2>&1 | head -1; done')
echo "$v" > $LOGS/03-versions.log
expect "every agreed tool runs" "$(echo "$v" | grep -c ' => .*[0-9]')" '^15$'
expect "node is 26, TypeScript is 7" "$(echo "$v" | grep -E '^node|tsc')" 'v26\..*Version 7\.'
refute "there is no Python, compiler, make, sudo or apt-installed browser" "$(run 'for c in python3 python gcc cc make sudo chromium; do command -v $c; done; echo none')" '^/'

u=$(run 'du -sxm / 2>/dev/null | cut -f1')
note "unpacked root filesystem, MB" "$u"
note "largest parts, MB" "$(run 'du -sxm /opt/chad/node_modules /usr/local/bin/uv /usr/local/bin/node /usr/lib /usr/bin /usr/share 2>/dev/null')"
note "largest packages in node_modules, MB" "$(run 'cd /opt/chad/node_modules/.pnpm && du -sm * | sort -n | tail -7 | cut -c1-44')"
expect "one copy of effect in the image" "$(run "find /opt/chad/node_modules -name package.json -path '*/node_modules/effect/package.json' | wc -l")" '^1$'
expect "the Claude SDK's JavaScript is there and its platform binary is not" "$(run 'ls /opt/chad/node_modules/.pnpm | grep -c "claude-agent-sdk@"; ls /opt/chad/node_modules/.pnpm | grep -c "claude-agent-sdk-"')" '^1 +0'
expect "clanka/ClaudeAgent imports in the final image" "$(docker run --rm --entrypoint node -w /opt/chad $IMG --input-type=module -e 'const m = await import("clanka/ClaudeAgent"); console.log("imported", Object.keys(m).length > 0)' 2>&1)" 'imported true'

# Compressed size: what a pull downloads. Push to a registry and add up the layers.
docker rm -f chadt-registry >/dev/null 2>&1
docker run -d --name chadt-registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null 2>&1
sleep 2
for tag in proto proto-arm64; do
  docker image inspect chad:$tag >/dev/null 2>&1 || { note "chad:$tag is not built, no compressed size"; continue; }
  docker tag chad:$tag localhost:5000/chad:$tag && docker push -q localhost:5000/chad:$tag >/dev/null 2>&1
  m=$(curl -s -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' localhost:5000/v2/chad/manifests/$tag)
  if echo "$m" | jq -e '.manifests' >/dev/null 2>&1; then
    d=$(echo "$m" | jq -r '[.manifests[] | select(.platform.os=="linux")][0].digest')
    m=$(curl -s -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' localhost:5000/v2/chad/manifests/$d)
  fi
  note "chad:$tag compressed, MB, and layers" "$(echo "$m" | jq -r '([.layers[].size] | add / 1048576 | floor | tostring) + " MB in " + (.layers | length | tostring) + " layers"') arch=$(docker image inspect chad:$tag --format '{{.Architecture}}')"
done
note "the base image compressed, MB" "$(docker pull -q node:26-trixie-slim >/dev/null 2>&1; docker tag node:26-trixie-slim localhost:5000/node:base; docker push -q localhost:5000/node:base >/dev/null 2>&1; m=$(curl -s -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' localhost:5000/v2/node/manifests/base); if echo "$m" | jq -e '.manifests' >/dev/null 2>&1; then d=$(echo "$m" | jq -r '[.manifests[] | select(.platform.architecture=="amd64")][0].digest'); m=$(curl -s -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' localhost:5000/v2/node/manifests/$d); fi; echo "$m" | jq -r '[.layers[].size] | add / 1048576 | floor')"
clean
