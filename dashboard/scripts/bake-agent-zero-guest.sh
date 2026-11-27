source ./bake-agent-zero-debs.sh
read_agent_zero_deb_lock verify "$PWD"
install -d -m 0700 "$PWD/empty-apt"
apt-get -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts="$PWD/empty-apt" \
  -o Dir::State::lists="$PWD/empty-apt" --no-remove \
  install -y --no-install-recommends "${AGENT_ZERO_DEBS[@]}"
for locked in "${AGENT_ZERO_DEB_VERSIONS[@]}"; do
  [ "$(dpkg-query -W -f='${db:Status-Status} ${Version}' "${locked%=*}")" = "installed ${locked#*=}" ] || exit 1
done
rm -rf -- "$PWD/debs" "$PWD/empty-apt"
systemctl enable qemu-guest-agent.service
install -d -o root -g root -m 0755 /etc/docker
[ ! -e /etc/docker/daemon.json ] && [ ! -L /etc/docker/daemon.json ]
printf '{"features":{"containerd-snapshotter":true}}\n' > /etc/docker/daemon.json
chown 0:0 . agent-zero.oci.tar
chmod 0700 .
chmod 0400 agent-zero.oci.tar
