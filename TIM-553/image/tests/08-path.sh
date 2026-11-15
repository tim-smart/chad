#!/usr/bin/env bash
# What the agent installs lands on the volume, comes after the image's tools on PATH, and caches under cache/.
T=path; . "$(dirname "$0")/common.sh"
start a; wait_phase a ready || fail "the daemon did not reach ready"

expect "PATH ends with the volume's two bin directories" "$(x a sh -c 'echo $PATH')" ':/bin:/data/home/\.npm-global/bin:/data/home/\.local/bin$'
expect "npm install -g works as uid 1000 and its command is on PATH" "$(x a sh -c 'npm install -g --no-audit --no-fund cowsay >/dev/null 2>&1; echo "npm exit=$?"; command -v cowsay; cowsay -h 2>&1 | head -1 | cut -c1-40')" 'npm exit=0 /data/home/\.npm-global/bin/cowsay'
expect "uv tool install works as uid 1000, with no Python in the image, and its command is on PATH" "$(x a sh -c 'uv tool install -q ruff 2>&1 | tail -2; echo "uv exit=$?"; command -v ruff; ruff --version')" 'uv exit=0 /data/home/\.local/bin/ruff ruff [0-9]'
note "uv run with a managed Python" "$(x a sh -c 'uv run -q --no-project python -c "import sys; print(sys.version.split()[0], sys.executable)" 2>&1 | tail -1')"
expect "the npm and uv caches are under cache/" "$(x a sh -c 'ls -d /data/cache/npm/_cacache /data/cache/uv 2>&1; du -sm /data/cache | cut -f1')" '^/data/cache/npm/_cacache /data/cache/uv [0-9]+$'
note "what is in home/ after the installs" "$(x a sh -c 'cd /data/home && find . -maxdepth 3 -not -path "./.npm-global/lib/*" | sort | tr "\n" " "; echo; du -sm /data/home | cut -f1') MB"
refute "nothing was cached under home/" "$(x a sh -c 'ls -d /data/home/.npm /data/home/.cache 2>/dev/null')" '.'

# Shadowing: the same names as the image's tools, dropped on the volume.
x a sh -c 'for d in /data/home/.local/bin /data/home/.npm-global/bin; do mkdir -p $d; for n in git chad node npm rg; do printf "#!/bin/sh\necho SHADOWED\n" > $d/$n; chmod +x $d/$n; done; done'
expect "a git, chad, node, npm or rg dropped on the volume does not shadow the image's" "$(x a sh -c 'for n in git chad node npm rg; do command -v $n; done; git --version; chad health; node -v')" '^/usr/bin/git /usr/local/bin/chad /usr/local/bin/node /usr/local/bin/npm /usr/bin/rg git version .* ok v26'
expect "the same holds for a command the daemon starts the way clanka does" "$(x a chad turn --session s1 --ms 1000 --child >/dev/null; sleep 1; x a sh -c 'tr "\0" "\n" < /proc/$(cat /data/sessions/s1/child.pid)/environ | grep "^PATH="')" ':/bin:/data/home/\.npm-global/bin:/data/home/\.local/bin$'
expect "a login shell resets PATH from /etc/profile, and the image's profile.d file puts the volume's directories back, last" "$(x a bash -lc 'echo $PATH; command -v ruff; command -v git')" '^/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games:/data/home/\.npm-global/bin:/data/home/\.local/bin /data/home/\.local/bin/ruff /usr/bin/git$'
expect "a login shell started from a shell that has them does not list them twice" "$(x a bash -lc 'bash -lc "echo \$PATH" | tr ":" "\n" | grep -c "^/data/home"')" '^2$'

# The volume outlives the container.
docker rm -f chadt-a >/dev/null; start a; wait_phase a ready
expect "after the container is replaced, both installs are still there and run" "$(x a sh -c 'rm /data/home/.local/bin/git /data/home/.local/bin/chad /data/home/.local/bin/node /data/home/.local/bin/npm /data/home/.local/bin/rg; command -v cowsay; command -v ruff; ruff --version')" '/data/home/\.npm-global/bin/cowsay /data/home/\.local/bin/ruff ruff [0-9]'
clean
