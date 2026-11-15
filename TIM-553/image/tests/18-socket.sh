#!/usr/bin/env bash
# CHAD_SOCKET: what it is for. A unix socket path holds 107 bytes, and a deep CHAD_DATA passes that.
T=socket; . "$(dirname "$0")/common.sh"
deep=/srv/$(printf 'a-long-directory-name-%.0s' 1 2 3 4 5)
mkdir -p ~/chadt-deep && rm -rf ~/chadt-deep/*
docker run -d --name chadt-deep -e CHAD_DATA=$deep -v ~/chadt-deep:$deep $IMG >/dev/null; sleep 4
expect "a CHAD_DATA so deep that the socket path passes 107 bytes: refused, with the length and CHAD_SOCKET named" "exit $(docker inspect chadt-deep --format '{{.State.ExitCode}}'): $(docker logs chadt-deep 2>&1 | grep -v '^{' | tail -1)" '^exit 1: chad serve: the socket path /srv/a-long.*/run/chad\.sock is 1[0-9]{2} bytes and a unix socket path holds 107\. Set CHAD_SOCKET to a shorter path'
docker rm -f chadt-deep >/dev/null; rm -rf ~/chadt-deep/*
docker run -d --name chadt-deep -e CHAD_DATA=$deep -e CHAD_SOCKET=/tmp/chad.sock -v ~/chadt-deep:$deep $IMG >/dev/null; wait_phase deep ready 60
expect "the same with CHAD_SOCKET=/tmp/chad.sock: the daemon boots and docker exec finds it" "$(x deep sh -c 'chad status | grep phase; chad health; ls -l /tmp/chad.sock | cut -c1-1')" '^phase: ready ok s$'
note "what Node says when the check is not there" "$(x deep node -e 'require("net").createServer().on("error", e => console.log(e.code, e.message.slice(0, 60))).listen(process.env.CHAD_DATA + "/run/x-chad.sock", function () { console.log("listening on a path of", Buffer.byteLength(this.address()), "bytes"); this.close() })')"
rm -rf ~/chadt-deep
clean
