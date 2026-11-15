#!/usr/bin/env bash
# ssh into the guest: ./ssh.sh <command>
cd "$(dirname "$0")"
exec ssh -q -i key -p 22553 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 tim@127.0.0.1 "$@"
