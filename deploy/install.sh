#!/usr/bin/env bash
# Puts chad, asphodel and Chromium on one Ubuntu or Debian server, and Tailscale on the server itself.
# `docs/deploying.md` is the guide. Run it as root.
#
#   install.sh           Installs, and on a later run updates the files and the images. The data is kept. It joins
#                        your tailnet first and starts no container until the server is on it. It never touches the
#                        firewall.
#   install.sh prepare   Installs Docker and Tailscale and fetches the files, and nothing more: it joins nothing and
#                        starts no container. `deploy/cloud-init.yaml` runs it on a server's first boot.
#   install.sh lockdown  Closes every public port, SSH included. It only does so in an SSH session that came in over
#                        Tailscale, which shows that way in works before the other one closes.
#
#   TS_AUTHKEY   A Tailscale auth key, for a join with nobody at the terminal. Without it the join prints a link to
#                sign in at. A server that is already on a tailnet refuses a key.
#   TS_HOSTNAME  The server's name on the tailnet. The default is chad.
#   CHAD_REF     The branch, tag or commit of tim-smart/chad that deploy/ is taken from. The default is main.
#   CHAD_DIR     Where the files go on the server. The default is /opt/chad.
set -euo pipefail

# What says a chad volume was given asphodel and the browser. It is on the volume, so it goes where the volume goes:
# a new volume has none, and a restored one has its own.
marker=/data/home/.deploy-seeded

main() {
  if [ "$(id -u)" != 0 ]; then
    echo "install.sh: run this as root" >&2
    exit 1
  fi
  case ${1:-install} in
    install) install ;;
    prepare) prepare ;;
    lockdown) lockdown ;;
    *)
      echo "usage: install.sh [prepare|lockdown]" >&2
      exit 2
      ;;
  esac
}

# What a server needs before it joins: the packages and the files. It holds no secret and starts nothing.
prepare() {
  local dir=${CHAD_DIR:-/opt/chad}
  local ref=${CHAD_REF:-main}

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
  # The pattern's star stops at a slash, so it takes the repository's own deploy/ and no directory of that name
  # deeper in the tree.
  curl -fsSL "https://codeload.github.com/tim-smart/chad/tar.gz/$ref" |
    tar -xz -C "$dir" --strip-components=2 --no-same-owner --wildcards --no-wildcards-match-slash '*/deploy'
}

install() {
  local dir=${CHAD_DIR:-/opt/chad}
  local hostname=${TS_HOSTNAME:-chad}

  prepare
  cd "$dir"

  # asphodel's token is made once and kept. The file is read by Compose and by root, and by nothing else.
  if [ ! -f .env ]; then
    (
      umask 077
      printf 'ASPHODEL_TOKEN=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >.env
    )
  fi

  # The join comes before any container, so nothing runs on a server you cannot reach privately, and a key is used up
  # before anything that runs here could read it. A key that joins nothing may still work, so nothing is started then.
  if [ -n "${TS_AUTHKEY:-}" ]; then
    # A server that is already on a tailnet would leave the key unused, and nothing here can tell whose tailnet it
    # is on.
    if on_tailnet; then
      {
        echo "install.sh: TS_AUTHKEY is set and the server is already on a tailnet, so the key was not used and"
        echo "nothing was started. \`tailscale status\` shows which tailnet it is on."
        echo "Revoke the key in the Tailscale admin console unless this server joined with it."
        echo "Then run this script again without TS_AUTHKEY."
      } >&2
      exit 1
    fi
    step "Joining the tailnet as $hostname"
    # The key goes in a file only root can read, so it is on no command line.
    local key joined=yes
    key=$(mktemp)
    printf %s "$TS_AUTHKEY" >"$key"
    tailscale up --auth-key="file:$key" --ssh --hostname="$hostname" --timeout=60s || joined=no
    rm -f "$key"
    if [ "$joined" = no ]; then
      {
        echo "install.sh: tailscale up failed, so nothing was started."
        echo "Revoke the key in the Tailscale admin console unless you know it was used or has expired."
        echo "Then run: tailscale up --ssh --hostname=$hostname, and this script again."
      } >&2
      exit 1
    fi
  elif ! on_tailnet; then
    step "Joining the tailnet as $hostname"
    echo "Open the link below and sign in to Tailscale. This waits ten minutes for you."
    if ! tailscale up --ssh --hostname="$hostname" --timeout=10m || ! on_tailnet; then
      echo "install.sh: the server did not join a tailnet, so nothing was started. Run this script again." >&2
      exit 1
    fi
  fi

  step "Starting chad, asphodel and Chromium"
  docker compose pull -q
  docker compose up -d --remove-orphans

  if ! healthy; then
    echo "install.sh: chad did not come up. See: cd $dir && docker compose logs chad" >&2
    exit 1
  fi

  if ! in_chad test -e "$marker" </dev/null; then
    step "Giving chad asphodel's token and the browser"
    # A function called as a condition runs with `set -e` off, and would go on past a step that failed. The subshell
    # is no condition, so the first step that fails ends it.
    set +e
    (
      set -e
      seed
    )
    local seeded=$?
    set -e
    if [ "$seeded" != 0 ]; then
      echo "install.sh: chad was not given all of asphodel and the browser. Run this script again to finish." >&2
      exit 1
    fi
  fi

  # The desktop and asphodel's dashboard are bound to the server's loopback. This puts each on the tailnet over
  # HTTPS, which the desktop's page needs to show video, and on no public address. The dashboard goes on before
  # asphodel is set up, so its first-run setup is done there too. That setup takes no token, so anyone your tailnet's
  # access rules let reach port 9443 can do it.
  step "Putting the browser's desktop and asphodel's dashboard on your tailnet"
  on_tailnet_https "the browser's desktop" 8443 3000 / "$hostname"
  on_tailnet_https "asphodel's dashboard" 9443 7720 /dashboard "$hostname"

  step "Done"
  docker compose ps
  echo "The server is on your tailnet. Its public ports are as they were, SSH included."
  echo "Once ssh root@$hostname works, close them from that session: bash $dir/install.sh lockdown"
  echo "Next: cd $dir && docker compose exec chad chad setup"
}

# Closes every public port. A Tailscale address alone does not show that you can get in over it, since your tailnet's
# policy decides that, so this asks for the proof: the session it runs in arrived at one of this server's Tailscale
# addresses. Nothing changes before both checks pass.
lockdown() {
  local arrived addresses rules others
  arrived=$(awk '{print $3}' <<<"${SSH_CONNECTION:-}")
  addresses=$(tailscale ip 2>/dev/null || true)
  if [ -z "$arrived" ] || ! grep -Fxq -- "$arrived" <<<"$addresses"; then
    {
      echo "install.sh: this is not an SSH session that came in over Tailscale, so nothing was closed."
      echo "Connect to the server by its name on your tailnet, as root, and run this again from there."
    } >&2
    exit 1
  fi

  # A rule that lets connections in outlives `default deny`. One that is not this script's is the owner's, and it is
  # neither kept in silence nor deleted. A list that could not be read is not an empty one.
  if ! rules=$(ufw show added); then
    echo "install.sh: ufw could not list its rules, so nothing was closed." >&2
    exit 1
  fi
  # grep exits 1 when it finds no line, which is the list this wants.
  others=$(
    grep -E '^ufw (allow|limit) ' <<<"$rules" |
      grep -Fxv -e 'ufw allow in on tailscale0' -e 'ufw allow 41641/udp' || true
  )
  if [ -n "$others" ]; then
    {
      echo "install.sh: these firewall rules would still let connections in, so nothing was closed:"
      echo "$others"
      echo "Delete each one, as in: ufw delete allow 22/tcp, and run this again."
    } >&2
    exit 1
  fi

  step "Closing every public port"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow in on tailscale0
  # Tailscale's own port, the one thing left open. With it two machines reach each other directly, and without it
  # they may fall back to a slower relay. It answers nothing that does not hold a key of your tailnet.
  ufw allow 41641/udp
  ufw --force enable
  echo "Every incoming connection is now refused unless it comes over Tailscale, SSH included."
  echo "41641/udp is open on purpose: it is Tailscale's own port."
}

step() {
  printf '\n==> %s\n' "$*"
}

# Serves a port of the server's loopback on the tailnet, over HTTPS, at another port. `tailscale serve` reaches the
# tailnet and nothing else, where `tailscale funnel` would reach the internet, so this never calls that. It can fail,
# or wait for an answer, for more than one reason, and a tailnet with HTTPS certificates off is one. So it gets a
# minute, and its failure does not fail the install.
on_tailnet_https() {
  local what=$1 https=$2 port=$3 path=$4 hostname=$5
  if ! timeout 60 tailscale serve --bg --https="$https" "http://127.0.0.1:$port"; then
    echo "install.sh: $what is not on the tailnet: tailscale serve failed or did not answer in a minute."
    echo "What it printed is above. HTTPS certificates that are off for your tailnet are one cause. Fix it and run this"
    echo "script again. Either way you can reach it with:"
    echo "  ssh -L $port:127.0.0.1:$port root@$hostname, then http://localhost:$port$path"
  fi
}

on_tailnet() {
  tailscale ip -4 >/dev/null 2>&1
}

# A command in chad's container. One that reads nothing is given no input, so it cannot take this script's.
in_chad() {
  docker compose exec -T chad "$@"
}

healthy() {
  for _ in $(seq 60); do
    if in_chad chad health >/dev/null 2>&1 </dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# What a chad volume is given, once: asphodel's token in the secret store, the asphodel and stale-tabs plugins turned
# on, the `browser` skill and agent-browser. Each part is skipped when the volume already has it, so a run that was
# cut is finished by the next, and what the owner changed is left alone. The marker is written last.
seed() {
  local token listed json pending wrote=no
  local new=/data/home/.deploy-seed.new
  token=$(sed -n 's/^ASPHODEL_TOKEN=//p' .env)

  listed=$(in_chad chad secret list </dev/null)
  if ! grep -q '^ASPHODEL_TOKEN\b' <<<"$listed"; then
    printf %s "$token" |
      in_chad chad secret set ASPHODEL_TOKEN --note "asphodel's bearer token, from deploy/install.sh"
  fi

  # chad.json on a new volume holds no plugin. One that holds anything else is the owner's. A file is written beside
  # the repo and moved in, so a write that is cut leaves no half of a file.
  json=$(in_chad cat /data/repo/work/chad.json </dev/null)
  if [ "$(tr -d ' \n\t' <<<"$json")" = '{"plugins":{}}' ]; then
    in_chad sh -c "cat > $new && mv $new /data/repo/work/chad.json" <<'EOF'
{
  "plugins": {
    "asphodel": {
      "enabled": true,
      "settings": {
        "url": "http://asphodel:7720",
        "token": "${ASPHODEL_TOKEN}"
      }
    },
    "stale-tabs": {
      "enabled": true,
      "settings": {
        "url": "http://172.30.72.10:9223"
      }
    }
  }
}
EOF
    wrote=yes
  fi

  if ! in_chad test -s /data/repo/work/skills/browser/SKILL.md </dev/null; then
    in_chad sh -c "mkdir -p /data/repo/work/skills/browser && cat > $new &&
      mv $new /data/repo/work/skills/browser/SKILL.md" <browser/SKILL.md
    wrote=yes
  fi

  # An apply is due for what this run wrote, and for what an earlier run wrote and was cut before applying.
  pending=$(in_chad git -C /data/repo/work status --porcelain -- chad.json skills/browser </dev/null)
  if [ "$wrote" = yes ] || [ -n "$pending" ]; then
    in_chad chad apply -m "Turn asphodel and stale-tabs on and add the browser skill" </dev/null
  fi

  if ! in_chad sh -c 'command -v agent-browser' >/dev/null </dev/null; then
    in_chad npm install -g --no-audit --no-fund agent-browser </dev/null
  fi

  in_chad touch "$marker" </dev/null
}

main "$@"
