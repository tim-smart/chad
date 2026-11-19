#!/bin/sh
# Signs in to GitHub with gh's device flow and saves the token in chad's secret store, as GITHUB_TOKEN or the name
# given as the first argument. It prints a one-time code and https://github.com/login/device for the owner, waits
# while they approve, and ends once the token is saved, or when the code expires after about 15 minutes.
#
# The token goes from gh to `chad secret set` on a pipe and is never printed. gh's login and state, and any git config
# gh writes, go in a directory of this run's own outside the volume, which is removed when the script ends or is
# stopped, so nothing under the home directory changes.
set -eu
name=${1:-GITHUB_TOKEN}
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
# gh refuses to sign in while a token is in its environment.
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
export GH_CONFIG_DIR="$dir/gh" GIT_CONFIG_GLOBAL="$dir/gitconfig" XDG_STATE_HOME="$dir/state"
# gh runs in the background and the script waits for it, so that a stop ends gh too, at once, and not when its code
# expires.
gh auth login --hostname github.com --git-protocol https --web --insecure-storage </dev/null &
login=$!
trap 'kill "$login" 2>/dev/null; exit 1' HUP INT TERM
wait "$login"
gh auth token --hostname github.com | chad secret set "$name" --note "GitHub, from a device sign-in the owner approved"
