#!/usr/bin/env bash
# Copies the prototype into the guest. Run from anywhere.
cd "$(dirname "$0")"
exec rsync -a --delete --exclude node_modules --exclude dist -e "ssh -q -i vm/key -p 22553 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" chad tests tim@127.0.0.1:proto/
