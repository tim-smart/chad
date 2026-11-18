#!/usr/bin/env bash
# Puts chad, asphodel and a headless Chromium on one Ubuntu or Debian server, and Tailscale on the server itself.
# `docs/deploying.md` is the guide. Run it as root. A second run updates the files and the images and keeps the data.
#
#   TS_AUTHKEY   A Tailscale auth key. With it the server joins your tailnet, and the firewall then closes every
#                public port, SSH included. Without it nothing about SSH or the firewall changes.
#   TS_HOSTNAME  The server's name on the tailnet. The default is chad.
#   CHAD_REF     The branch, tag or commit of tim-smart/chad that deploy/ is taken from. The default is main.
#   CHAD_DIR     Where the files go on the server. The default is /opt/chad.
set -euo pipefail

main() {
  local dir=${CHAD_DIR:-/opt/chad}
  local ref=${CHAD_REF:-main}
  local hostname=${TS_HOSTNAME:-chad}

  if [ "$(id -u)" != 0 ]; then
    echo "install.sh: run this as root" >&2
    exit 1
  fi
  if ! command -v apt-get >/dev/null; then
    echo "install.sh: this needs apt-get, so Ubuntu or Debian" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive

  step "Installing curl and ufw"
  apt-get update -q
  apt-get install -y -q ca-certificates curl tar ufw

  if ! docker compose version >/dev/null 2>&1; then
    step "Installing Docker"
    curl -fsSL https://get.docker.com | sh
  fi
  if ! command -v tailscale >/dev/null; then
    step "Installing Tailscale"
    curl -fsSL https://tailscale.com/install.sh | sh
  fi

  step "Fetching deploy/ at $ref into $dir"
  mkdir -p "$dir"
  chmod 700 "$dir"
  curl -fsSL "https://codeload.github.com/tim-smart/chad/tar.gz/$ref" |
    tar -xz -C "$dir" --strip-components=2 --no-same-owner --wildcards '*/deploy/*'
  cd "$dir"

  # asphodel's token is made once and kept. The file is read by Compose and by root, and by nothing else.
  if [ ! -f .env ]; then
    (
      umask 077
      printf 'ASPHODEL_TOKEN=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >.env
    )
  fi

  step "Starting chad, asphodel and Chromium"
  docker compose pull -q
  docker compose up -d --remove-orphans

  if [ ! -e .seeded ]; then
    step "Giving chad asphodel's token and the browser"
    if seed; then
      touch .seeded
    else
      echo "install.sh: chad was not given asphodel and the browser. Run install.sh again once chad is up." >&2
    fi
  fi

  local tailnet=no
  if tailscale ip -4 >/dev/null 2>&1; then
    tailnet=yes
  elif [ -n "${TS_AUTHKEY:-}" ]; then
    step "Joining the tailnet as $hostname"
    # The key goes in a file only root can read, so it is on no command line.
    local key
    key=$(mktemp)
    printf %s "$TS_AUTHKEY" >"$key"
    if tailscale up --auth-key="file:$key" --ssh --hostname="$hostname" --timeout=60s; then
      tailnet=yes
    else
      echo "install.sh: tailscale up failed, so the firewall is left as it was" >&2
    fi
    rm -f "$key"
  fi

  # Only a server that is on the tailnet loses its public SSH port, so a bad key never locks you out.
  if [ "$tailnet" = yes ]; then
    step "Closing every public port"
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow in on tailscale0
    # Tailscale's own port, which lets two machines talk directly and not through a relay.
    ufw allow 41641/udp
    ufw --force enable
  fi

  step "Done"
  docker compose ps
  if [ "$tailnet" = yes ]; then
    echo "The server is on your tailnet as $(tailscale status --self --peers=false | awk 'NR==1 {print $2}')."
    echo "Its public ports are closed. Reach it with: ssh root@$hostname"
  else
    echo "The server is not on a tailnet, and its SSH port and firewall are as they were."
    echo "To join one, run: tailscale up --ssh --hostname=$hostname, then run this script again."
  fi
  echo "Next: cd $dir && docker compose exec chad chad setup"
}

step() {
  printf '\n==> %s\n' "$*"
}

# What a new chad volume is given, once: asphodel's token in the secret store, the asphodel plugin turned on, the
# `browser` skill and agent-browser. Each part is skipped when the volume already has it, so a volume that was
# restored or changed by hand is left alone.
seed() {
  local chad=(docker compose exec -T chad)
  local token ready=no changed=no
  token=$(sed -n 's/^ASPHODEL_TOKEN=//p' .env)

  for _ in $(seq 60); do
    if "${chad[@]}" chad health >/dev/null 2>&1; then
      ready=yes
      break
    fi
    sleep 2
  done
  [ "$ready" = yes ] || return 1

  if ! "${chad[@]}" chad secret list | grep -q '^ASPHODEL_TOKEN\b'; then
    printf %s "$token" |
      "${chad[@]}" chad secret set ASPHODEL_TOKEN --note "asphodel's bearer token, from deploy/install.sh"
  fi

  # chad.json on a new volume holds no plugin. One that holds anything else is the owner's.
  if [ "$("${chad[@]}" cat /data/repo/work/chad.json | tr -d ' \n\t')" = '{"plugins":{}}' ]; then
    "${chad[@]}" sh -c 'cat > /data/repo/work/chad.json' <<'EOF'
{
  "plugins": {
    "asphodel": {
      "enabled": true,
      "settings": {
        "url": "http://asphodel:7720",
        "token": "${ASPHODEL_TOKEN}"
      }
    }
  }
}
EOF
    changed=yes
  fi

  if ! "${chad[@]}" test -e /data/repo/work/skills/browser; then
    "${chad[@]}" mkdir -p /data/repo/work/skills/browser
    "${chad[@]}" sh -c 'cat > /data/repo/work/skills/browser/SKILL.md' <browser/SKILL.md
    changed=yes
  fi

  if [ "$changed" = yes ]; then
    "${chad[@]}" chad apply -m "Turn asphodel on and add the browser skill"
  fi

  if ! "${chad[@]}" sh -c 'command -v agent-browser' >/dev/null; then
    "${chad[@]}" npm install -g --no-audit --no-fund agent-browser
  fi
}

main "$@"
