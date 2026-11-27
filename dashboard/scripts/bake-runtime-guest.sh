#!/usr/bin/env bash
set -euo pipefail
umask 022

cd /root/hivra-image-bake
generalize_image() {
  cloud-init clean --logs --machine-id
  install -m 0444 /dev/null /etc/machine-id
  rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id /var/lib/systemd/random-seed
  rm -rf /root/.ssh /home/ubuntu/.ssh /var/lib/cloud/seed
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  find /var/log -type f -exec truncate -s 0 -- {} +
}

case "$1" in
  generalize) generalize_image; exit 0 ;;
  official-hermes|deepseek-harness|ubuntu-qga|agent-zero|bux-dependencies) ;;
  *) exit 64 ;;
esac
source ./runtime-bake-pins.env
export DEBIAN_FRONTEND=noninteractive
if [ "$1" = agent-zero ]; then
  source ./bake-agent-zero-guest.sh
  exit 0
fi
if [ "$1" != bux-dependencies ]; then
  PACKAGES=(qemu-guest-agent)
  if [ "$1" != ubuntu-qga ]; then
    PACKAGES+=(ca-certificates curl git gnupg libatomic1 sudo tmux wget xz-utils)
  fi
  apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
  apt-get -o Acquire::Retries=3 install -y --no-install-recommends "${PACKAGES[@]}"
  systemctl enable qemu-guest-agent.service
fi

install -d /etc/hivra
if [ "$1" = bux-dependencies ]; then
  source ./bake-bux-dependencies-guest.sh
elif [ "$1" = ubuntu-qga ]; then
  read -r status version < <(dpkg-query -W -f='${db:Status-Status} ${Version}\n' qemu-guest-agent)
  [[ "$status" = installed && "$version" =~ ^[0-9][A-Za-z0-9.+:~-]{0,127}$ ]]
  [ -x /usr/sbin/qemu-ga ]
  printf '{"schema":1,"kind":"ubuntu-qga","baseImageSha256":"%s","qemuGuestAgentVersion":"%s"}\n' \
    "$BASE_IMAGE_SHA256" "$version" > /etc/hivra/ubuntu-qga-bake.json
else
  source ./bake-fetch.sh
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" node.tar.xz
  install -d /opt/hivra
  tar --no-same-owner -xJf node.tar.xz -C /opt/hivra
  NODE_ROOT="/opt/hivra/node-v$NODE_VERSION-linux-x64"
  for binary in node npm npx corepack; do
    [ -x "$NODE_ROOT/bin/$binary" ]
  done
  source "./bake-$1-guest.sh"
fi

generalize_image
