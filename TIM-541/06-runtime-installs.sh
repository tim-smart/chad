#!/usr/bin/env bash
# Fact 6: runtime installs as uid 1000 with HOME=/data/home
T=chadfacts-tools:latest
C=chadfacts-rt
podman rm -f -t 0 $C >/dev/null 2>&1; podman volume rm -f chadfacts-rtvol >/dev/null 2>&1
ENVS="-e HOME=/data/home -e NPM_CONFIG_PREFIX=/data/home/.npm-global -e PATH=/data/home/.npm-global/bin:/data/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
echo "### first container (kept, so podman diff can show what landed outside the volume)"
podman run --name $C --user node $ENVS -v chadfacts-rtvol:/data $T bash -c '
set +e
mkdir -p $HOME; id; echo HOME=$HOME
echo "--- npm install -g cowsay (NPM_CONFIG_PREFIX=$NPM_CONFIG_PREFIX)"
npm install -g --no-audit --no-fund cowsay 2>&1 | tail -2; echo "exit=$?"
echo "npm prefix -g: $(npm prefix -g)   npm cache: $(npm config get cache)"
command -v cowsay; cowsay ok | head -2
echo "--- npm install -g WITHOUT the prefix (default /usr/local) as uid 1000"
env -u NPM_CONFIG_PREFIX npm install -g --no-audit --no-fund cowsay 2>&1 | grep -E "EACCES|code|path|syscall" | head -4
echo "--- uv dirs"
echo "uv tool dir: $(uv tool dir)"; echo "uv tool bin dir: $(uv tool dir --bin)"; echo "uv cache dir: $(uv cache dir)"; echo "uv python dir: $(uv python dir)"
echo "--- uv tool install pycowsay"
uv tool install pycowsay 2>&1 | tail -6; echo "exit=$?"
command -v pycowsay; pycowsay ok | head -3
echo "--- uvx ruff --version"
uvx ruff --version 2>&1 | tail -2
echo "--- apt-get install as uid 1000"
apt-get install -y jq 2>&1 | tail -3; echo "exit=$?"
apt-get update 2>&1 | tail -2
echo "--- sudo / su available?"; command -v sudo || echo "sudo: MISSING"
echo "--- write outside /data as uid 1000"; touch /usr/local/bin/x 2>&1; touch /opt/x 2>&1; touch /tmp/x && echo "/tmp writable"; touch /home/node/x && echo "/home/node writable"
echo "--- sizes under /data/home"
du -sh /data/home/.npm-global /data/home/.npm /data/home/.cache/uv /data/home/.local/share/uv/tools /data/home/.local/share/uv/python /data/home/.local/bin 2>&1
'
echo
echo "### podman diff of that container (changes to the image filesystem, i.e. NOT on the volume; lost when the container is replaced):"
podman diff $C | sed 's/^/   /' | head -30
podman rm -f -t 0 $C >/dev/null
echo
echo "### second, new container on the same volume (what survived)"
podman run --rm --name $C --user node $ENVS -v chadfacts-rtvol:/data $T bash -c '
command -v cowsay && cowsay survived | head -2
command -v pycowsay && pycowsay survived | head -3
uv tool list; uv python list --only-installed 2>&1 | head -3
ls /tmp/x /home/node/x 2>&1
'
podman volume rm -f chadfacts-rtvol >/dev/null 2>&1
