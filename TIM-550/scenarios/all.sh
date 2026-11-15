#!/usr/bin/env bash
# runs every scenario, one log per claim under ../logs
here="$(cd "$(dirname "$0")" && pwd)"
for s in "$@"; do
  echo "== $s"; bash "$here/$s.sh" > "$here/../logs/$s.log" 2>&1; echo "   done (exit $?)"
done
