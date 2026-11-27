python3 -I ./hivra-bux-bake.py assets > assets.tsv
while IFS=$'\t' read -r _ checksum name; do
  printf '%s  assets/%s\n' "$checksum" "$name" | sha256sum --check --status -
done < assets.tsv

install -d empty-apt-lists
apt-get -y --no-install-recommends -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=/dev/null \
  -o Dir::State::lists="$PWD/empty-apt-lists" install "$PWD"/assets/*.deb
auto_packages="$(python3 -I ./hivra-bux-bake.py auto-packages)"
read -r -a auto_package_array <<< "$auto_packages"
apt-mark auto "${auto_package_array[@]}"

install -d -m 0755 /etc/apt/keyrings
install -m 0644 assets/githubcli.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg
gpg --batch --dearmor < assets/nodesource.asc > /etc/apt/keyrings/nodesource.gpg
chmod 0644 /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' \
  > /etc/apt/sources.list.d/github-cli.list
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' \
  > /etc/apt/sources.list.d/nodesource.list

tar -xzf assets/uv.tgz -C assets
install -m 0755 assets/uv-x86_64-unknown-linux-gnu/{uv,uvx} assets/ttyd /usr/local/bin/
systemctl enable qemu-guest-agent.service
systemctl disable atd.service
install -d -m 0755 /etc/hivra
python3 -I ./hivra-bux-bake.py seal "$BASE_IMAGE_SHA256"
