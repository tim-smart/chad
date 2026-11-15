#!/usr/bin/env bash
# Boots a Debian 13 guest under KVM with Docker CE from Docker's own apt repository.
# This machine's "docker" is a wrapper around rootless podman, so the real engine runs in here.
set -euo pipefail
cd "$(dirname "$0")"
test -f disk.qcow2 || qemu-img create -q -f qcow2 -b debian.qcow2 -F qcow2 disk.qcow2 60G
test -f seed.iso || xorriso -as mkisofs -quiet -o seed.iso -V cidata -J -r user-data meta-data
exec qemu-system-x86_64 -enable-kvm -cpu host -smp 8 -m 12G \
  -drive file=disk.qcow2,if=virtio -drive file=seed.iso,media=cdrom \
  -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:22553-:22 \
  -display none -serial file:serial.log -daemonize -pidfile qemu.pid
