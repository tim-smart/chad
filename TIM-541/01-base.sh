#!/usr/bin/env bash
# Fact 1: base image inspection
cat logs/01-pull.log
podman images --format '{{.Repository}}:{{.Tag}} {{.Size}} {{.ID}}' | grep 'library/node' | sort
for t in 26-bookworm-slim 26-trixie-slim 26-alpine; do
  echo "=== node:$t"
  podman image inspect docker.io/library/node:$t --format 'size={{.Size}} user="{{.Config.User}}" entrypoint={{.Config.Entrypoint}} cmd={{.Config.Cmd}} stopsignal="{{.Config.StopSignal}}" env={{.Config.Env}} digest={{.Digest}}'
  podman run --rm --name chadfacts-base docker.io/library/node:$t sh -c '
    echo "whoami=$(whoami) id=$(id)"; id node; grep node /etc/passwd
    node -v; npm -v; node -e "require(\"node:sqlite\"); console.log(\"node:sqlite ok\", process.versions.sqlite)"
    (ldd --version 2>&1 | head -1) ; (cat /etc/os-release | grep PRETTY)
    for b in bash git curl wget tini dumb-init rg sqlite3 gh python3 uv corepack yarn pnpm ps; do if command -v $b >/dev/null; then echo "$b: present $(command -v $b)"; else echo "$b: MISSING"; fi; done
    if [ -e /etc/ssl/certs/ca-certificates.crt ]; then echo "ca-certificates: present"; else echo "ca-certificates: MISSING (/etc/ssl/certs/ca-certificates.crt)"; fi
    (dpkg -l ca-certificates 2>&1 | tail -1) || true
    ls -ld /home/node /usr/local/lib/node_modules
    node -e "fetch(\"https://registry.npmjs.org/\").then(r=>console.log(\"node fetch https status\",r.status),e=>console.log(\"fetch err\",e.cause?.code||e.message))"
  '
done
