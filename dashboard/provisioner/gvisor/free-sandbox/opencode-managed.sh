#!/bin/sh
# Prints OpenCode's managed config for the free sandbox image from the free plan's models (comma separated,
# `opencode/<model>`, the first pinned). Anything else is refused, so a typo fails the build instead of shipping.
set -eu
models="${1:-}"
[ -n "$models" ] || { echo "FREE_MODELS is required" >&2; exit 1; }
first=""
list=""
old_ifs=$IFS
IFS=,
for m in $models; do
  case "$m" in
    opencode/*) ;;
    *) echo "free models must be OpenCode's own (opencode/<model>): $m" >&2; exit 1 ;;
  esac
  name=${m#opencode/}
  if ! printf '%s' "$name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'; then
    echo "not a model id: $m" >&2; exit 1
  fi
  [ -n "$first" ] || first=$m
  list="$list${list:+,}\"$name\""
done
IFS=$old_ifs
cat <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "enabled_providers": ["opencode"],
  "model": "$first",
  "small_model": "$first",
  "provider": { "opencode": { "whitelist": [$list] } },
  "autoupdate": false,
  "share": "disabled"
}
JSON
