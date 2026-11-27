#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$#" -ne 2 ] || ! [[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]] || [ ! -d "$2" ]; then
  printf 'usage: bash %s UPSTREAM_INDEX_DIGEST EXISTING_OUTPUT_DIRECTORY\n' "$0" >&2
  exit 64
fi

PIN="$1"
OUT="$(cd "$2" && pwd)"
REPO=agent0ai/agent-zero
REGISTRY="https://registry-1.docker.io/v2/$REPO"
INDEX_TYPE=application/vnd.oci.image.index.v1+json
MANIFEST_TYPE=application/vnd.oci.image.manifest.v1+json
FETCH=(curl --fail --silent --show-error --location --retry 2 --connect-timeout 20 --max-time 600 --proto '=https' --proto-redir '=https')
WORK="$(mktemp -d "$OUT/.agent-zero-container.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
cd "$WORK"
mkdir -p blobs/sha256
TOKEN="$("${FETCH[@]}" "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$REPO:pull" | jq -er '.token | select(type == "string" and length > 0)')"

fetch_digest() {
  local resource="$1" digest="$2" media="$3" output
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  output="blobs/sha256/${digest#sha256:}"
  "${FETCH[@]}" -H "Authorization: Bearer $TOKEN" -H "Accept: $media" \
    --output "$output" "$REGISTRY/$resource/$digest"
  printf '%s  %s\n' "${digest#sha256:}" "$output" | sha256sum --strict --check --status -
}

fetch_digest manifests "$PIN" "$INDEX_TYPE"
INDEX="blobs/sha256/${PIN#sha256:}"
AMD64="$(jq -er --arg index "$INDEX_TYPE" --arg manifest "$MANIFEST_TYPE" '
  select(.schemaVersion == 2 and .mediaType == $index)
  | [.manifests[] | select(.mediaType == $manifest and .platform.os == "linux" and .platform.architecture == "amd64")]
  | select(length == 1) | .[0].digest
' "$INDEX")"
fetch_digest manifests "$AMD64" "$MANIFEST_TYPE"
MANIFEST="blobs/sha256/${AMD64#sha256:}"
jq -er --arg manifest "$MANIFEST_TYPE" '
  select(.schemaVersion == 2 and .mediaType == $manifest and (.layers | length > 0))
  | [.config, .layers[]] | map(.digest) | unique | .[]
' "$MANIFEST" > digests
while IFS= read -r digest; do
  fetch_digest blobs "$digest" application/octet-stream
done < digests

jq -n --arg type "$INDEX_TYPE" --arg digest "$PIN" --argjson size "$(stat -c %s "$INDEX")" \
  --arg ref "docker.io/$REPO@$PIN" '{
    schemaVersion: 2, manifests: [{mediaType: $type, digest: $digest, size: $size,
      annotations: {"io.containerd.image.name": $ref, "org.opencontainers.image.ref.name": $ref}}]
  }' > index.json
printf '{"imageLayoutVersion":"1.0.0"}\n' > oci-layout
tar --sort=name --format=ustar --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -cf image.tar index.json oci-layout blobs
ARCHIVE="$OUT/agent-zero-linux-amd64-${PIN#sha256:}.oci.tar"
chmod 0400 image.tar
ln -T -- image.tar "$ARCHIVE"
sha256sum "$ARCHIVE"
