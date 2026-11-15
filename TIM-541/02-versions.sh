#!/usr/bin/env bash
# Fact 2: resulting image size, per-layer sizes, tool versions
podman images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E 'chadfacts-tools|node:26-trixie-slim'
podman image inspect chadfacts-tools:latest --format 'bytes={{.Size}}'
podman image inspect docker.io/library/node:26-trixie-slim --format 'base bytes={{.Size}}'
podman history --format '{{.Size}}\t{{.CreatedBy}}' chadfacts-tools:latest | cut -c1-150 | head -8
podman run --rm --name chadfacts-ver chadfacts-tools:latest bash -c '
git --version; rg --version | head -1; sqlite3 --version; gh --version | head -1; curl --version | head -1; uv --version; uvx --version; tini --version; bash --version | head -1
dpkg -l ca-certificates | tail -1 | awk "{print \$2, \$3}"
apt-cache policy gh | head -6
ls -la /bin/uv /bin/uvx /usr/bin/gh /usr/bin/rg /usr/bin/tini | awk "{print \$5, \$9}"
command -v python3 || echo "python3: MISSING (uv downloads its own)"
'
echo "--- gh candidate in Debian's own repo (no GitHub apt repo):"
podman run --rm --name chadfacts-ver2 docker.io/library/node:26-trixie-slim bash -c 'apt-get update -qq >/dev/null 2>&1; apt-cache policy gh | head -4; apt-cache policy ripgrep git sqlite3 tini | grep -E "^[a-z]|Candidate"'
podman run --rm --name chadfacts-ver3 docker.io/library/node:26-bookworm-slim bash -c 'apt-get update -qq >/dev/null 2>&1; echo bookworm:; apt-cache policy gh ripgrep git sqlite3 tini | grep -E "^[a-z]|Candidate"'
