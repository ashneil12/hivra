#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -ne 2 ] || [ ! -d "$2" ]; then
  printf 'usage: bash %s {official-hermes|deepseek-harness|ubuntu-qga|agent-zero|bux-dependencies} EXISTING_OUTPUT_DIRECTORY\n' "$0" >&2
  exit 64
fi
KIND="$1"
OUT="$(cd "$2" && pwd)"
MEMORY_MB="${HIVRA_BAKE_MEMORY_MB:-4096}"
case "$MEMORY_MB" in 4096|6144|8192) ;; *) printf 'unsupported bake memory size\n' >&2; exit 64 ;; esac
PINS="$ROOT/runtime-bake-pins.env"
DISK_GB=8
NETWORK_MODE=--network
case "$KIND" in
  official-hermes) NAME_PREFIX=hivra-hermes; MARKER=/etc/hivra/hermes-bake.json ;;
  deepseek-harness) NAME_PREFIX=hivra-deepseek-harness; MARKER=/etc/hivra/deepseek-harness-bake.json ;;
  ubuntu-qga) NAME_PREFIX=hivra-ubuntu-qga; MARKER=/etc/hivra/ubuntu-qga-bake.json; PINS="$ROOT/ubuntu-qga-bake-pins.env" ;;
  agent-zero) NAME_PREFIX=hivra-agent-zero; MARKER=/etc/hivra/agent-zero-bake.json; DISK_GB=24; NETWORK_MODE=--no-network ;;
  bux-dependencies) NAME_PREFIX=hivra-bux-dependencies; MARKER=/etc/hivra/bux-dependencies-bake.json; PINS="$ROOT/ubuntu-qga-bake-pins.env"; NETWORK_MODE=--no-network ;;
  *) printf 'unsupported bake runtime\n' >&2; exit 64 ;;
esac
WORK="$(mktemp -d "$OUT/.runtime-bake.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
source "$PINS"
source "$ROOT/bake-fetch.sh"
STAGE="$WORK/hivra-image-bake"
install -d -m 0700 "$STAGE"
install -m 0644 "$ROOT/bake-runtime-guest.sh" "$STAGE"
install -m 0644 "$PINS" "$STAGE/runtime-bake-pins.env"
if [ "$KIND" != ubuntu-qga ]; then
  install -m 0644 "$ROOT/bake-fetch.sh" "$ROOT/bake-$KIND-guest.sh" "$STAGE"
fi
case "$KIND" in
  official-hermes)
    source "$ROOT/hermes-bake-pins.env"
    install -m 0644 "$ROOT/hermes-bake-pins.env" "$STAGE"
    fetch "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh" \
      "$HERMES_INSTALLER_SHA256" "$STAGE/hermes-install.sh"
    ;;
  agent-zero)
    source "$ROOT/agent-zero-bake-pins.env"
    source "$ROOT/bake-agent-zero-image.sh"
    source "$ROOT/bake-agent-zero-debs.sh"
    install -m 0644 "$ROOT/bake-agent-zero-debs.sh" "$ROOT/agent-zero-debs.lock" "$STAGE"
    install -d -m 0700 "$STAGE/debs"
    read_agent_zero_deb_lock fetch "$STAGE"
    install -m 0644 "$ROOT/agent-zero-bake-pins.env" "$ROOT/bake-agent-zero-preload.sh" "$STAGE"
    bash "$ROOT/bake-agent-zero-container.sh" "$AGENT_ZERO_INDEX_DIGEST" "$WORK"
    mv -- "$WORK/agent-zero-linux-amd64-${AGENT_ZERO_INDEX_DIGEST#sha256:}.oci.tar" "$STAGE/agent-zero.oci.tar"
    printf '%s  %s\n' "$AGENT_ZERO_ARCHIVE_SHA256" "$STAGE/agent-zero.oci.tar" | sha256sum --strict --check --status -
    ;;
  deepseek-harness)
    NATIVE="$ROOT/../provisioner/deepseek-harness"
    install -m 0644 "$NATIVE/install-native.py" "$NATIVE/package.json" "$NATIVE/package-lock.json" "$STAGE"
    ;;
  bux-dependencies)
    install -m 0644 "$ROOT/../provisioner/bux-bake-lock.json" "$ROOT/../provisioner/hivra-bux-bake.py" "$STAGE"
    bash "$ROOT/bake-bux-dependencies-stage.sh" "$STAGE"
    ;;
esac
fetch "$BASE_IMAGE_URL" "$BASE_IMAGE_SHA256" "$WORK/base.qcow2"

export LIBGUESTFS_BACKEND=direct
DISK_BYTES=$((DISK_GB * 1024 * 1024 * 1024))
qemu-img create -f qcow2 -F qcow2 -b "$WORK/base.qcow2" "$WORK/build.qcow2" "$DISK_BYTES"
guestfish --format=qcow2 -a "$WORK/build.qcow2" run \
  : part-expand-gpt /dev/sda \
  : part-resize /dev/sda 1 "$((DISK_BYTES / 512 - 34))" \
  : e2fsck-f /dev/sda1 \
  : resize2fs /dev/sda1
STAGE_CLEANUP=(--delete /root/hivra-image-bake)
if [ "$KIND" = agent-zero ]; then STAGE_CLEANUP=(); fi
virt-customize --format qcow2 -a "$WORK/build.qcow2" "$NETWORK_MODE" --no-logfile --memsize "$MEMORY_MB" --smp 4 \
  --copy-in "$STAGE:/root" \
  --run-command "env -i HOME=/root LANG=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash /root/hivra-image-bake/bake-runtime-guest.sh $KIND" \
  "${STAGE_CLEANUP[@]}"
if [ "$KIND" = agent-zero ]; then
  bake_agent_zero_preload
  virt-customize --format qcow2 -a "$WORK/build.qcow2" --no-network --no-logfile --memsize "$MEMORY_MB" --smp 4 \
    --run-command 'env -i HOME=/root LANG=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash /root/hivra-image-bake/bake-runtime-guest.sh generalize' \
    --delete /root/hivra-image-bake
fi
virt-sparsify --format qcow2 --convert qcow2 --compress "$WORK/build.qcow2" "$WORK/sealed.qcow2"
qemu-img check -f qcow2 "$WORK/sealed.qcow2"
qemu-img info --output=json "$WORK/sealed.qcow2" | jq -e --argjson diskBytes "$DISK_BYTES" '
  .format == "qcow2" and .["virtual-size"] == $diskBytes
  and (has("backing-filename") or has("full-backing-filename") | not)
  and (.["format-specific"].data | has("data-file") | not)
' >/dev/null
virt-cat --format=qcow2 -a "$WORK/sealed.qcow2" "$MARKER" > "$WORK/marker.json"
jq -e --arg kind "$KIND" --arg base "$BASE_IMAGE_SHA256" \
  '.schema == 1 and .kind == $kind and .baseImageSha256 == $base' "$WORK/marker.json" >/dev/null
if [ "$KIND" = ubuntu-qga ]; then
  jq -e '
    keys == ["baseImageSha256", "kind", "qemuGuestAgentVersion", "schema"]
    and (.qemuGuestAgentVersion | test("^[0-9][A-Za-z0-9.+:~-]{0,127}$"))
  ' "$WORK/marker.json" >/dev/null
fi

if [ "$KIND" = agent-zero ]; then
  jq -e --arg digest "$AGENT_ZERO_INDEX_DIGEST" --arg archive "$AGENT_ZERO_ARCHIVE_SHA256" '
    keys == ["archiveSha256", "baseImageSha256", "imageDigest", "kind", "schema"]
    and .imageDigest == $digest and .archiveSha256 == $archive
  ' "$WORK/marker.json" >/dev/null
fi

if [ "$KIND" = bux-dependencies ]; then
  read -r LOCK_SHA _ < <(sha256sum "$STAGE/bux-bake-lock.json")
  jq -e --arg lock "$LOCK_SHA" '
    keys == ["baseImageSha256", "dependencyLockSha256", "kind", "schema"]
    and .dependencyLockSha256 == $lock
  ' "$WORK/marker.json" >/dev/null
fi

read -r IMAGE_SHA _ < <(sha256sum "$WORK/sealed.qcow2")
NAME="$NAME_PREFIX-$IMAGE_SHA"
jq -e --arg imageSha256 "$IMAGE_SHA" '. + {format: "qcow2", imageSha256: $imageSha256}' "$WORK/marker.json" > "$WORK/manifest.json"
ln -T -- "$WORK/sealed.qcow2" "$OUT/$NAME.qcow2"
if ! ln -T -- "$WORK/manifest.json" "$OUT/$NAME.json"; then
  rm -- "$OUT/$NAME.qcow2"
  exit 1
fi
printf 'Baked %s.qcow2 and %s.json\n' "$OUT/$NAME" "$OUT/$NAME"
