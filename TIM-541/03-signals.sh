#!/usr/bin/env bash
# Fact 3: PID 1, SIGTERM, --init, orphan reaping
IMG=docker.io/library/node:26-trixie-slim
S=$PWD/03-signals
procs() { podman exec $1 sh -c 'for s in /proc/[0-9]*/stat; do awk "{print \"pid=\"\$1, \$2, \"state=\"\$3, \"ppid=\"\$4}" $s 2>/dev/null; done'; }
stopcase() { # name, extra-run-args..., -- cmd
  local name=$1; shift
  echo; echo "##### $name: podman run -d $*"
  podman rm -f $name >/dev/null 2>&1
  podman run -d --name $name -v $S:/s:ro "$@" >/dev/null
  sleep 1.5
  echo "-- processes:"; procs $name
  local t0=$(date +%s%N)
  podman stop $name >/dev/null 2>stop.err; cat stop.err; rm -f stop.err
  local t1=$(date +%s%N)
  echo "-- podman stop took $(( (t1 - t0) / 1000000 )) ms; exit code $(podman inspect $name --format '{{.State.ExitCode}}') ; StopSignal=$(podman inspect $name --format '{{.Config.StopSignal}}') StopTimeout=$(podman inspect $name --format '{{.Config.StopTimeout}}')"
  echo "-- logs:"; podman logs $name 2>&1 | sed 's/^/   /'
  podman rm -f $name >/dev/null
}
stopcase chadfacts-sig-a $IMG node /s/graceful.mjs
stopcase chadfacts-sig-b --init $IMG node /s/graceful.mjs
stopcase chadfacts-sig-c $IMG node /s/nohandler.mjs
stopcase chadfacts-sig-d --init $IMG node /s/nohandler.mjs
stopcase chadfacts-sig-e $IMG sh -c 'node /s/graceful.mjs; echo node-exited-$?'
stopcase chadfacts-sig-f --entrypoint "" $IMG /bin/sh -c 'node /s/graceful.mjs'

orphancase() {
  local name=$1; shift
  echo; echo "##### $name orphans: podman run -d $*"
  podman rm -f $name >/dev/null 2>&1
  podman run -d --name $name -v $S:/s:ro "$@" >/dev/null
  sleep 0.5
  # exec session whose child is orphaned: the shell exits at once, sleep lives 1s more
  podman exec $name sh -c '(sleep 1 &) ; exit 0'
  podman exec $name sh -c '(sleep 1 &) ; exit 0'
  echo "-- right after exec (orphans still running):"; procs $name
  sleep 2.5
  echo "-- 2.5s later (orphans have exited):"; procs $name
  echo "-- zombies: $(procs $name | grep -c 'state=Z')"
  podman rm -f -t 0 $name >/dev/null
}
orphancase chadfacts-orph-a $IMG node /s/graceful.mjs orphan
orphancase chadfacts-orph-b --init $IMG node /s/graceful.mjs orphan
echo; echo "podman info init path:"; podman info --format '{{.Host.Conmon.Path}}' ; podman run --rm --init --name chadfacts-initver $IMG sh -c 'cat /proc/1/cmdline | tr "\0" " "; echo; /run/podman-init --version 2>&1 || /dev/init --version 2>&1'
