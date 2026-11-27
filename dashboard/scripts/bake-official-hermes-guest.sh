#!/usr/bin/env bash
set -euo pipefail
umask 022

cd /root/hermes-bake
source ./hermes-bake-pins.env
export DEBIAN_FRONTEND=noninteractive

fetch() {
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 300 "$1" --output "$3"
  printf '%s  %s\n' "$2" "$3" | sha256sum --check --status -
}

apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
  ca-certificates curl git gnupg libatomic1 qemu-guest-agent sudo tmux wget xz-utils
systemctl enable qemu-guest-agent.service

fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" node.tar.xz
install -d /opt/hivra
tar --no-same-owner -xJf node.tar.xz -C /opt/hivra
for binary in node npm npx corepack; do
  [ -x "/opt/hivra/node-v$NODE_VERSION-linux-x64/bin/$binary" ]
  ln -s "/opt/hivra/node-v$NODE_VERSION-linux-x64/bin/$binary" "/usr/local/bin/$binary"
done
fetch "https://github.com/tsl0922/ttyd/releases/download/$TTYD_VERSION/ttyd.x86_64" "$TTYD_SHA256" ttyd
install -m 0755 ttyd /usr/local/bin/ttyd
fetch "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64" \
  "$CLOUDFLARED_SHA256" cloudflared
install -m 0755 cloudflared /usr/local/bin/cloudflared
fetch "https://cli.github.com/packages/pool/main/g/gh/gh_${GH_VERSION}_amd64.deb" "$GH_SHA256" github-cli.deb
install -m 0644 github-cli.deb /tmp/hivra-github-cli.deb
apt-get install -y /tmp/hivra-github-cli.deb
rm -f /tmp/hivra-github-cli.deb

useradd --uid 1001 --create-home --home-dir /home/bux --shell /bin/bash bux
install -m 0755 hermes-install.sh /tmp/hivra-hermes-install.sh
as_bux() {
  runuser -u bux -- env -i HOME=/home/bux HERMES_HOME=/home/bux/.hermes USER=bux LOGNAME=bux SHELL=/bin/bash \
    LANG=C.UTF-8 CI=1 PATH=/home/bux/.local/bin:/usr/local/bin:/usr/bin:/bin "$@" </dev/null
}
cd /home/bux
as_bux bash /tmp/hivra-hermes-install.sh --non-interactive --skip-browser --channel stable --commit "$HERMES_COMMIT"
source_dir=/home/bux/.hermes/hermes-agent
[ "$(as_bux git -C "$source_dir" rev-parse --verify HEAD)" = "$HERMES_COMMIT" ]
[ "$(as_bux git -C "$source_dir" remote get-url origin)" = https://github.com/NousResearch/hermes-agent.git ]
[ "$(as_bux git -C "$source_dir" for-each-ref --format='%(upstream)' refs/heads/main)" = refs/remotes/origin/main ]
as_bux hermes webapp --build-only

clean_hermes_profile() {
  find /home/bux/.hermes -maxdepth 1 -mindepth 1 \
    ! -name hermes-agent ! -name installs ! -name tools ! -name skills -exec rm -rf -- {} +
}
clean_hermes_profile
rm -rf /home/bux/.cache /home/bux/.npm /home/bux/.ssh /home/bux/.config /home/bux/.hivra /home/bux/.bash_history
rm -f /tmp/hivra-hermes-install.sh
chmod 0700 /home/bux/.hermes

version_text="$(as_bux hermes --version)"
[[ "${version_text%%$'\n'*}" =~ (^|[[:space:]])v?"$HERMES_VERSION"([[:space:]]|$) ]]
[ -s "$source_dir/apps/desktop/dist-webapp/index.html" ]
as_bux hermes config set webapp.enabled true >/dev/null
clean_hermes_profile
hermes_python="$(as_bux hermes --print-runtime-command | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0])')"
as_bux "$hermes_python" -I -B -c '
from pathlib import Path
import sys

root = Path(sys.argv[1])
sys.path.insert(0, str(root))
from hermes_cli.source_build import source_product_current
from hermes_cli.webapp import webapp_bundle_stale
from pm.environments import committed_venv

if committed_venv(root) is None:
    sys.exit("Hermes package manager has no committed dependency environment")

for product, dist in (("web", root / "hermes_cli/web_dist"), ("webapp", root / "apps/desktop/dist-webapp")):
    if not (dist / "index.html").is_file() or not source_product_current(root, product, dist):
        sys.exit(f"Hermes {product} build is missing or its upstream receipt is stale")
    if product == "webapp" and webapp_bundle_stale(dist):
        sys.exit("Hermes Webapp is marked stale")
' "$source_dir"

cloud-init clean --logs --machine-id
rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id /var/lib/systemd/random-seed
rm -rf /root/.ssh /home/ubuntu/.ssh /var/lib/cloud/seed
apt-get clean
rm -rf /var/lib/apt/lists/*
find /var/log -type f -exec truncate -s 0 -- {} +
install -d -o root -g root -m 0755 /etc/hivra
printf '{"schema":1,"kind":"official-hermes","baseImageSha256":"%s","hermesVersion":"%s","hermesCommit":"%s","hermesInstallerSha256":"%s"}\n' \
  "$BASE_IMAGE_SHA256" "$HERMES_VERSION" "$HERMES_COMMIT" "$HERMES_INSTALLER_SHA256" > /etc/hivra/hermes-bake.json
