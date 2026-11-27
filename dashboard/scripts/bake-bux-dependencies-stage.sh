#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bake-fetch.sh"
cd "$1"
install -d assets
python3 -I ./hivra-bux-bake.py assets > assets.tsv
while IFS=$'\t' read -r url checksum name; do
  printf '%s\n' "$url" "$checksum" "assets/$name"
done < assets.tsv > fetch.args
export -f fetch
xargs -d '\n' -n 3 -P 8 bash -e -c 'fetch "$@"' _ < fetch.args
rm -- assets.tsv fetch.args
