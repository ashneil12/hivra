#!/usr/bin/env bash
# Build the Hivra overlay image on a digest-pinned stock upstream image, then run the guards and the
# tests. Runs on a self-hosted machine with Docker (no hosted CI minutes). Does NOT push.
# Usage: scripts/build-overlay.sh <upstream-tag e.g. v0.21.6> <overlay-version> [upstream-checkout]
set -euo pipefail
TAG=${1:?upstream tag}; VER=${2:?overlay version}; UPSRC=${3:-}
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO_SHA=$(git -C "$HERE" rev-parse --short=12 HEAD)
# Upstream publishes nousresearch/hermes-agent:stable and rc.N-<tag>; resolve the index digest, pin it.
DIGEST=$(docker buildx imagetools inspect "nousresearch/hermes-agent:${HIVRA_UPSTREAM_REF:-stable}" --format '{{json .Manifest.Digest}}' | tr -d '"')
UPSTREAM_IMAGE="nousresearch/hermes-agent@${DIGEST}"
echo "upstream: $UPSTREAM_IMAGE (tag $TAG)"
docker pull -q "$UPSTREAM_IMAGE" >/dev/null
UPSTREAM_REV=$(docker run --rm --entrypoint sh "$UPSTREAM_IMAGE" -c 'grep -o "\"commit\": \"[0-9a-f]*\"" /opt/hermes/install-stamp.json' | grep -o '[0-9a-f]\{40\}')
IMG="hivra-hermes:${TAG}-${VER}-${REPO_SHA}"
docker buildx build --platform "${PLATFORM:-linux/amd64}" --load \
  --build-arg UPSTREAM_IMAGE="$UPSTREAM_IMAGE" --build-arg UPSTREAM_TAG="$TAG" \
  --build-arg OVERLAY_VERSION="$VER" --build-arg VCS_REF="$(git -C "$HERE" rev-parse HEAD)" \
  --build-arg UPSTREAM_REVISION="$UPSTREAM_REV" ${WEB_MODE:+--build-arg WEB_MODE=$WEB_MODE} -t "$IMG" "$HERE"
"$HERE/scripts/check-overlay.sh" "$IMG" "$UPSTREAM_IMAGE"
[ -z "$UPSRC" ] || "$HERE/scripts/run-tests.sh" "$IMG" "$UPSRC"
echo "built $IMG (not pushed). Push as an immutable tag, never :stable/:latest."
