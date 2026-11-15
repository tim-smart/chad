#!/usr/bin/env bash
# PROTOTYPE (TIM-554). Run one scenario in a container that stands in for the chad container:
# the scenario's data directory is /data, the tools installed on the volume are /data/home/.local,
# and the network namespace is the Chromium sidecar's, as in a pod.
#   in-container.sh <out-id> <scenario> [phase]   (extra environment: CHAD_CRED_ENV="-e A=B -e C=D")
set -eu
here=$(cd "$(dirname "$0")" && pwd)
id=$1; shift
mkdir -p "$here/out/$id/data/home/.local"
exec podman run --rm --name "chad-cred-chad-$id" --userns=keep-id --network container:chad-cred-chromium \
  -v "$here/../swap:$here/../swap:ro" -v "$here:$here" \
  -v "$here/out/$id/data:/data" -v "$here/vol/home/.local:/data/home/.local:ro" -v "$here/out/$id:/o" \
  -e HOME=/data/home -e CHAD_DATA=/data -e PROTO_LOG=/o/log.jsonl \
  -e PATH="$here/bin:/data/home/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  ${CHAD_CRED_ENV:-} -w "$here" node:26-trixie-slim node --disable-warning=ExperimentalWarning scenarios.ts "$@"
