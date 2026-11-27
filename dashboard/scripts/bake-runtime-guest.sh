#!/usr/bin/env bash
set -euo pipefail
umask 022

cd /root/hivra-image-bake
case "$1" in official-hermes|deepseek-harness) ;; *) exit 64 ;; esac
source ./runtime-bake-pins.env
source ./bake-fetch.sh
export DEBIAN_FRONTEND=noninteractive

apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
  ca-certificates curl git gnupg libatomic1 qemu-guest-agent sudo tmux wget xz-utils
systemctl enable qemu-guest-agent.service

fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" node.tar.xz
install -d /opt/hivra /etc/hivra
tar --no-same-owner -xJf node.tar.xz -C /opt/hivra
NODE_ROOT="/opt/hivra/node-v$NODE_VERSION-linux-x64"
for binary in node npm npx corepack; do
  [ -x "$NODE_ROOT/bin/$binary" ]
done
source "./bake-$1-guest.sh"

cloud-init clean --logs --machine-id
install -m 0444 /dev/null /etc/machine-id
rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id /var/lib/systemd/random-seed
rm -rf /root/.ssh /home/ubuntu/.ssh /var/lib/cloud/seed
apt-get clean
rm -rf /var/lib/apt/lists/*
find /var/log -type f -exec truncate -s 0 -- {} +
