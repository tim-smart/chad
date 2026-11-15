#!/usr/bin/env bash
# PROTOTYPE for TIM-538. Shows why the snapshot must keep the mtime of the index it copies.
# A file is rewritten with the same size in the same clock tick as the last index write.
# Usage: racy-snapshot.sh <empty scratch dir>
set -euo pipefail
X="2026-01-01 00:00:00.500000000"
setup() {
  rm -rf "$1"; mkdir -p "$1"; cd "$1"
  git init -q -b main; git config user.name t; git config user.email t@t
  printf 'aaaa\n' > f; git add f; git commit -qm one
  touch -d "$X" f
  git reset -q HEAD            # the index now records f with mtime X
  touch -d "$X" .git/index     # the index was written in the same tick
  printf 'bbbb\n' > f; touch -d "$X" f   # same size, same tick
}
verdict() { if [ "$1" = "$(git rev-parse 'HEAD^{tree}')" ]; then echo "MISSED the edit"; else echo "saw the edit"; fi; }

setup "$1/plain";  echo "git status in work/:            $(git status --porcelain | grep -q f && echo 'saw the edit' || echo 'MISSED the edit')"
setup "$1/copy";   cp .git/index ../snap;     echo "index copied, new mtime:        $(verdict "$(GIT_INDEX_FILE=../snap git add -A && GIT_INDEX_FILE=../snap git write-tree)")"
setup "$1/keep";   cp -p .git/index ../snap2; echo "index copied, mtime kept:       $(verdict "$(GIT_INDEX_FILE=../snap2 git add -A && GIT_INDEX_FILE=../snap2 git write-tree)")"
setup "$1/empty";  echo "empty index, every file hashed: $(verdict "$(GIT_INDEX_FILE=../snap3 git add -A && GIT_INDEX_FILE=../snap3 git write-tree)")"
