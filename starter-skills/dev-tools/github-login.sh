#!/bin/sh
# Signs gh in to GitHub with a device code the owner approves, and sets git up to use that login. It prints a one-time
# code and https://github.com/login/device, and waits while the owner approves. The code expires after about 15
# minutes. Then:
#
# - gh keeps the login where it always does, in ~/.config/gh on the volume, so `gh auth status` passes from then on,
#   in every session, and this script does no second login.
# - git uses gh's login for github.com, unless git already has a credential helper.
# - git commits with the GitHub account's name and no-reply email, unless ~/.gitconfig already sets an identity or
#   includes another file.
#
# It ends by naming the account it signed in as. The token is never printed. A stop ends gh at once, and not when its
# code expires.
set -eu
host=github.com
# gh refuses to sign in while a token is in its environment, and a token there is not a login that lasts.
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN

if gh auth status --hostname "$host" >/dev/null 2>&1; then
  echo "gh is already signed in to $host."
else
  gh auth login --hostname "$host" --git-protocol https --web --insecure-storage </dev/null &
  login=$!
  trap 'kill "$login" 2>/dev/null; exit 1' HUP INT TERM
  wait "$login"
  trap - HUP INT TERM
fi

# Only whether a helper is set is read, never its value, which can hold a secret.
if git config --global --get-regexp '^credential\..*helper$' >/dev/null 2>&1; then
  echo "git keeps the credential helper it has."
else
  gh auth setup-git --hostname "$host"
  echo "git signs in to $host with gh's login."
fi

# A failed lookup stops the script here, before git is given an empty identity.
account=$(gh api user --jq '[.id, .login, (.name // .login)] | @tsv')
tab=$(printf '\t')
IFS=$tab read -r id user name <<EOF
$account
EOF
echo "gh is signed in to $host as $user."

if git config --global --get-regexp '^(user\.|include)' >/dev/null 2>&1; then
  echo "git keeps the identity ~/.gitconfig gives it."
else
  git config --global user.name "$name"
  git config --global user.email "$id+$user@users.noreply.$host"
  echo "git commits as $name <$id+$user@users.noreply.$host>."
fi
