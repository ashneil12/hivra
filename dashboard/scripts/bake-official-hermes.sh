#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  printf 'usage: bash %s EXISTING_OUTPUT_DIRECTORY\n' "$0" >&2
  exit 64
fi
OUT="$(cd "$1" && pwd)"
WORK="$(mktemp -d "$OUT/.hermes-bake.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
source "$ROOT/hermes-bake-pins.env"
install -m 0644 "$ROOT/hermes-bake-pins.env" "$ROOT/bake-official-hermes-guest.sh" "$WORK"

download() {
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 300 "$1" --output "$3"
  printf '%s  %s\n' "$2" "$3" | sha256sum --check --status -
}

download "$BASE_IMAGE_URL" "$BASE_IMAGE_SHA256" "$WORK/base.qcow2"
download "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh" \
  "$HERMES_INSTALLER_SHA256" "$WORK/hermes-install.sh"
chmod 0644 "$WORK/hermes-install.sh"

export LIBGUESTFS_BACKEND=direct
qemu-img create -f qcow2 "$WORK/build.qcow2" 8G
virt-resize --format qcow2 --output-format qcow2 --expand /dev/sda1 "$WORK/base.qcow2" "$WORK/build.qcow2"
virt-customize --format qcow2 -a "$WORK/build.qcow2" --network --no-logfile --memsize 6144 --smp 4 \
  --mkdir /root/hermes-bake \
  --copy-in "$WORK/hermes-bake-pins.env:/root/hermes-bake" \
  --copy-in "$WORK/hermes-install.sh:/root/hermes-bake" \
  --copy-in "$WORK/bake-official-hermes-guest.sh:/root/hermes-bake" \
  --run-command 'env -i HOME=/root LANG=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash /root/hermes-bake/bake-official-hermes-guest.sh' \
  --delete /root/hermes-bake
virt-sparsify --format qcow2 --convert qcow2 --compress "$WORK/build.qcow2" "$WORK/sealed.qcow2"
qemu-img check -f qcow2 "$WORK/sealed.qcow2"
qemu-img info --output=json "$WORK/sealed.qcow2" | jq -e '.format == "qcow2" and (has("backing-filename") | not)' >/dev/null

read -r IMAGE_SHA _ < <(sha256sum "$WORK/sealed.qcow2")
NAME="hivra-hermes-$IMAGE_SHA"
virt-cat --format qcow2 -a "$WORK/sealed.qcow2" /etc/hivra/hermes-bake.json \
  | jq -e --arg imageSha256 "$IMAGE_SHA" '. + {format: "qcow2", imageSha256: $imageSha256}' > "$WORK/manifest.json"
ln -- "$WORK/sealed.qcow2" "$OUT/$NAME.qcow2"
ln -- "$WORK/manifest.json" "$OUT/$NAME.json"
printf 'Baked %s.qcow2 and %s.json\n' "$OUT/$NAME" "$OUT/$NAME"
