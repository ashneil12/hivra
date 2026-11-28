#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HIVRA_BAKE_MEMORY_MB="${HIVRA_HERMES_BAKE_MEMORY_MB:-4096}" \
  exec bash "$ROOT/bake-runtime-image.sh" official-hermes "$@"
