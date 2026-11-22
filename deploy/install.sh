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
# What says use_browse() is moving the files of a change into chad's repo and has not applied them yet. It holds the
# applied tree the change was worked out from and the tree it makes, so a run that was cut is finished by the next.
browse_pending=/data/home/.deploy-browse-pending
# browse's MCP server, as chad's mcp.json names it, and what says the installer added it once. Its calls may wait on
# the owner for up to ten minutes, as a handoff does, so they get a little longer than that.
browse_server='{"command":"browse","args":["mcp"],"callTimeout":660000}'
browse_mcp_added=/data/home/.deploy-browse-mcp
browse_mcp="{
  \"mcpServers\": {
    \"browse\": $browse_server
  }
}"
# The stale-tabs entry and the `browser` skills that earlier versions of this script seeded, when chad drove Chromium
# through DevTools with agent-browser. use_browse() takes out what is still exactly as seeded, and leaves alone what
# the owner changed.
old_stale_tabs='{"enabled":true,"settings":{"url":"http://172.30.72.10:9223"}}'
old_browser_skills="
5155aba737eca7d385376999833ba5a2a2dc2f9094c6eefb129b1cf4df49495e
5c2d7d3bd71c491c132471ce05c33d00c0de2fba874580f05a0df300e65f110e
5a68d355cf678df986644305e69a21ffad8fd63e4d9217ae58d582c960377422
587df3db77c53edd732537e8da46ba2e12c1b3b2598a47a77b2ffa29ddb2142f
f66d1c8ef0a7b1f2558396ae55f96da57c7917a4050101b1a29cb3cdafa40581
"

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

  step "Installing browse on chad's volume"
  part install_browse "browse was not installed on chad's volume."

  if ! in_chad test -e "$marker" </dev/null; then
    step "Giving chad asphodel's token and the browser"
    part seed "chad was not given all of asphodel and the browser."
  fi

  # Every run, so a volume seeded before chad used browse is moved onto it.
  step "Moving chad's repo onto browse"
  part use_browse "chad's repo was not moved onto browse."

  # The desktop and asphodel's dashboard are bound to the server's loopback. This puts each on the tailnet over
  # HTTPS, which the desktop's page needs to show video, and on no public address. The dashboard goes on before
  # asphodel is set up, so its first-run setup is done there too. That setup takes no token, so anyone your tailnet's
  # access rules let reach port 9443 can do it.
  step "Putting the browser's desktop and asphodel's dashboard on your tailnet"
  on_tailnet_https "the browser's desktop" 8443 3000 / "$hostname"
  on_tailnet_https "asphodel's dashboard" 9443 7720 /dashboard "$hostname"

  pair "$dir"

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

# Runs one part of the install, and ends the install when it fails. A function called as a condition runs with
# `set -e` off, and would go on past a step that failed. The subshell is no condition, so the first step that fails
# ends it.
part() {
  local status
  set +e
  (
    set -e
    "$1"
  )
  status=$?
  set -e
  if [ "$status" != 0 ]; then
    echo "install.sh: $2 Run this script again to finish." >&2
    exit 1
  fi
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

# What a chad volume is given, once: asphodel's token in the secret store, the asphodel plugin turned on, browse's
# MCP server and the `browser` skill. Each part is skipped when the volume already has it, so a run that was cut is finished by the next,
# and what the owner changed is left alone. The marker is written last.
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
    }
  }
}
EOF
    wrote=yes
  fi

  if ! in_chad test -e /data/repo/work/mcp.json </dev/null; then
    in_chad sh -c "cat > $new && mv $new /data/repo/work/mcp.json" <<<"$browse_mcp"
    wrote=yes
  fi

  if ! in_chad test -s /data/repo/work/skills/browser/SKILL.md </dev/null; then
    in_chad sh -c "mkdir -p /data/repo/work/skills/browser && cat > $new &&
      mv $new /data/repo/work/skills/browser/SKILL.md" <browser/SKILL.md
    wrote=yes
  fi

  # An apply is due for what this run wrote, and for what an earlier run wrote and was cut before applying.
  pending=$(in_chad git -C /data/repo/work status --porcelain -- chad.json mcp.json skills/browser </dev/null)
  if [ "$wrote" = yes ] || [ -n "$pending" ]; then
    in_chad chad apply -m "Turn asphodel on and add browse and the browser skill" </dev/null
  fi

  in_chad touch "$marker" </dev/null
}

# browse on chad's volume, with its relay open to the Chromium container. It comes before anything applies mcp.json,
# so the apply that adds browse's MCP server finds the command and connects it.
install_browse() {
  if ! in_chad sh -c 'command -v browse' >/dev/null </dev/null; then
    in_chad npm install -g --no-audit --no-fund --no-update-notifier @opencode/browse </dev/null
  fi
  # The extension reaches the relay from the Chromium container, so the relay listens beyond chad's loopback. Setting
  # this restarts a relay that runs, so it is set only when it is not so already. What it prints is for a browser on
  # another computer, with an address the extension here does not use, so it is not shown.
  if ! in_chad grep -qs '"hostname": *"0.0.0.0"' /data/home/.config/browse/config.json </dev/null; then
    in_chad browse set hostname 0.0.0.0 >/dev/null </dev/null
  fi
}

# Moves a volume onto browse: its MCP server added to mcp.json once, and what an earlier seed gave chad for
# agent-browser taken out where it is still as seeded. It runs on every install and changes only what is not so
# already.
#
# Every change is worked out from the applied tree, not from work/, and becomes one tree: the applied tree with the
# changed files in it, whose files git holds from then on. The marker names the applied tree it started from and that
# tree, and `chad apply --expect` publishes it or nothing, so a change the owner makes to work/ meanwhile is never
# published with it. A run that was cut is finished by the next, from git's copy of the files.
use_browse() {
  local work=/data/repo/work
  local applied files="" stale sum mcp base expected ready

  applied=$(in_chad git -C "$work" rev-parse 'applied^{tree}' </dev/null)
  if in_chad test -e "$browse_pending" </dev/null; then
    read -r base expected < <(in_chad cat "$browse_pending" </dev/null)
    if [ "$base" = "$applied" ]; then
      finish_browse "$base" "$expected"
      return 0
    fi
    # Something was applied since, so what it worked out is out of date. It starts over from what is applied now.
    in_chad rm -f "$browse_pending" </dev/null
  fi

  # Not local, so the trap still has it when the subshell this runs in exits.
  tmp=$(in_chad mktemp -d /data/home/.deploy-browse.XXXXXX </dev/null)
  trap 'in_chad rm -rf "$tmp" </dev/null' EXIT
  in_chad sh -c "cd $work && git show $applied:chad.json > $tmp/applied-chad.json &&
    { git show $applied:mcp.json > $tmp/applied-mcp.json 2>/dev/null || rm -f $tmp/applied-mcp.json; }" </dev/null

  # The seeded stale-tabs entry points at Chromium's DevTools, which the deploy no longer opens, and browse closes the
  # idle tabs it opened. An entry the owner changed is theirs: it stays, and is reported when it points there too.
  stale=$(
    in_chad node - "$tmp/applied-chad.json" "$tmp/chad.json" "$old_stale_tabs" <<'EOF'
const fs = require("node:fs")
const [file, staged, seeded] = process.argv.slice(2)
let json
try {
  json = JSON.parse(fs.readFileSync(file, "utf8"))
} catch {
  process.exit(0)
}
const entry = JSON.stringify(json?.plugins?.["stale-tabs"] ?? null)
if (entry === seeded) {
  delete json.plugins["stale-tabs"]
  fs.writeFileSync(staged, JSON.stringify(json, null, 2) + "\n", { flag: "wx" })
  console.log("seeded")
} else if (entry.includes("172.30.72.10:9223") && json.plugins["stale-tabs"].enabled === true) {
  console.log("changed")
}
EOF
  )
  if [ "$stale" = seeded ]; then
    files="$files chad.json"
  elif [ "$stale" = changed ]; then
    echo "chad.json has a stale-tabs entry that is not the one this script added, so it was left as it is. It points"
    echo "at Chromium's DevTools, which this deploy no longer opens, so it closes no tab: browse closes the idle tabs it"
    echo "opened. Take the entry out of chad.json, or point its url at a Chromium of your own."
  fi

  # A skill the owner changed is theirs too.
  sum=$(in_chad sh -c "git -C $work show $applied:skills/browser/SKILL.md 2>/dev/null | sha256sum" </dev/null)
  if grep -qx "${sum%% *}" <<<"$old_browser_skills"; then
    in_chad sh -c "mkdir -p $tmp/skills/browser && cat > $tmp/skills/browser/SKILL.md" <browser/SKILL.md
    files="$files skills/browser/SKILL.md"
  elif in_chad sh -c "git -C $work show $applied:skills/browser/SKILL.md 2>/dev/null | grep -q agent-browser" \
    </dev/null; then
    echo "work/skills/browser/SKILL.md is not the one this script added, so it was left as it is. It still says to use"
    echo "agent-browser, which no longer reaches Chromium. $PWD/browser/SKILL.md is the one for browse."
  fi

  # browse's MCP server, added once. A server of the owner's named browse is theirs, and one they take out later stays
  # out: the marker says it was added, and is set only once the applied tree has it.
  if ! in_chad test -e "$browse_mcp_added" </dev/null; then
    mcp=$(
      in_chad node - "$tmp/applied-mcp.json" "$tmp/mcp.json" "$browse_server" <<'EOF'
const fs = require("node:fs")
const [file, staged, server] = process.argv.slice(2)
let json = { mcpServers: {} }
if (fs.existsSync(file)) {
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    json = undefined
  }
}
if (typeof json !== "object" || json === null || Array.isArray(json)) {
  console.log("malformed")
  process.exit(0)
}
json.mcpServers ??= {}
if (json.mcpServers.browse !== undefined) {
  console.log("present")
  process.exit(0)
}
json.mcpServers.browse = JSON.parse(server)
fs.writeFileSync(staged, JSON.stringify(json, null, 2) + "\n", { flag: "wx" })
console.log("added")
EOF
    )
    if [ "$mcp" = added ]; then
      files="$files mcp.json"
    elif [ "$mcp" = present ]; then
      in_chad touch "$browse_mcp_added" </dev/null
    else
      echo "mcp.json could not be read, so browse's MCP server was not added to it. Fix it, and run this script again."
    fi
  fi

  if [ -z "$files" ]; then
    return 0
  fi
  # The applied tree with the staged files in it, through an index of its own so work/'s is untouched.
  expected=$(
    in_chad sh -c 'set -e
      applied=$1 tmp=$2
      shift 2
      export GIT_INDEX_FILE=$tmp/index
      cd /data/repo/work
      git read-tree "$applied"
      for path in "$@"; do
        git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/$path"),$path"
      done
      git write-tree' sh "$applied" "$tmp" $files </dev/null
  )
  in_chad sh -c "echo $applied $expected > $tmp/pending && mv $tmp/pending $browse_pending" </dev/null
  finish_browse "$applied" "$expected"
}

# Puts what `expected` changes from `base` into work/ and applies it. work/ may differ from `base` only where
# `expected` does, and there only by holding what `expected` holds, which is what a run that was cut moved in already.
# Anything else is the owner's: then it applies nothing, and says so. A file is moved in only over the applied one.
# Files it moved in before it met the owner's stay, as a cut run's do, and the next run finishes from them.
finish_browse() {
  local base=$1 expected=$2 ready changed
  ready=$(
    in_chad sh -c 'set -e
      base=$1 expected=$2
      dir=$(mktemp -d /data/home/.deploy-finish.XXXXXX)
      trap "rm -rf $dir" EXIT
      cd /data/repo/work
      blob() { git rev-parse -q --verify "$1:$2" || true; }
      # work/ as `chad apply` snapshots it (src/Repo.ts).
      export GIT_INDEX_FILE=$dir/index
      git add -A -- . ":(exclude,glob)**/node_modules" ":(exclude,glob)**/node_modules/**"
      draft=$(git write-tree)
      ours=" $(git diff-tree -r --name-only "$base" "$expected" | tr "\n" " ")"
      for path in $(git diff-tree -r --name-only "$base" "$draft"); do
        case $ours in *" $path "*) ;; *) echo owner; exit 0 ;; esac
        [ "$(blob "$draft" "$path")" = "$(blob "$expected" "$path")" ] || { echo owner; exit 0; }
      done
      # A file goes in only in place of the applied one, judged by what it actually displaced: a check before the move
      # would leave the owner a moment to save the file in between. A path the applied tree lacks is linked in, which
      # fails when the path is there. One the applied tree has is swapped with the new file in one rename, so the file
      # that comes out is the one that was there. When that is not the applied one it belongs to the owner, and it is
      # swapped back. What that brings out is the file of this script, unless the owner saved again in between, and
      # then it is kept.
      for path in $ours; do
        want=$(blob "$expected" "$path")
        had=$(blob "$base" "$path")
        [ "$(blob "$draft" "$path")" != "$want" ] || continue
        new=$dir/new/$path
        mkdir -p "$(dirname "$path")" "$(dirname "$new")"
        git cat-file blob "$want" > "$new"
        if [ -z "$had" ]; then
          ln "$new" "$path" 2>/dev/null || { echo owner; exit 0; }
        else
          mv --exchange "$new" "$path"
          if [ "$(git hash-object "$new")" != "$had" ]; then
            mv --exchange "$new" "$path"
            if [ "$(git hash-object "$new")" != "$want" ]; then
              saved=/data/home/.deploy-browse-saved/$path.$(date +%s)
              mkdir -p "$(dirname "$saved")"
              mv "$new" "$saved"
              echo "saved $saved"
            fi
            echo owner
            exit 0
          fi
        fi
      done
      echo ready' sh "$base" "$expected" </dev/null
  )
  grep "^saved " <<<"$ready" | sed "s|^saved |An edit of yours that came in as this script moved a file in is kept at |" || true
  ready=$(tail -n 1 <<<"$ready")
  if [ "$ready" != ready ]; then
    echo "chad's repo has changes that are not applied, so the move to browse was not applied: an apply would publish"
    echo "them with it. Apply or undo yours, and run this script again."
    return 0
  fi
  in_chad chad apply -m "Browse with browse in place of agent-browser" --expect "$expected" </dev/null
  changed=$(in_chad git -C /data/repo/work diff-tree -r --name-only "$base" "$expected" </dev/null)
  if grep -qx mcp.json <<<"$changed"; then
    in_chad touch "$browse_mcp_added" </dev/null
  fi
  in_chad rm -f "$browse_pending" </dev/null
}

# The browse extension in Chromium has to be paired with the relay in chad's container once, by hand: the relay prints
# a code and the owner enters it on the desktop. chad cannot use the browser until then, but everything else works,
# so a pairing that does not happen does not fail the install.
pair() {
  local dir=$1 listed
  listed=$(in_chad browse pair --list </dev/null || true)
  if grep -q '^  profile ' <<<"$listed"; then
    return 0
  fi
  step "Pairing chad with the browser"
  echo "Open the browser's desktop, at port 8443 of this server on your tailnet, and do what the lines below say in its"
  echo "Chromium. The Extensions menu is the puzzle piece next to the address bar, and Options is under the three dots"
  echo "beside browse. Chromium adds browse a few seconds after it starts."
  if ! in_chad browse pair --wait-seconds 600 </dev/null; then
    echo "chad is not paired with the browser. To pair later: cd $dir && docker compose exec chad browse pair"
  fi
}

main "$@"
