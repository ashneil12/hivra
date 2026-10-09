#!/usr/bin/env bash
# Run the overlay tests inside the overlay image against the upstream test tree (so upstream's
# conftest fixtures apply). Usage: scripts/run-tests.sh <overlay-image> <upstream-checkout> [pytest args]
# <upstream-checkout> is a checkout of the SAME upstream tag the image was built from.
set -euo pipefail
IMG=${1:?overlay image}; UP=${2:?upstream checkout}; shift 2
HERE=$(cd "$(dirname "$0")/.." && pwd)
docker run --rm --entrypoint sh -e HIVRA_TEST_SEAMS_EXCLUDE \
  -v "$UP/tests:/upstream-tests:ro" -v "$HERE/tests:/overlay-tests:ro" \
  -v "$HERE/scripts/_in-image-pytest.sh:/run.sh:ro" "$IMG" /run.sh "${@:-tests/hivra}"
