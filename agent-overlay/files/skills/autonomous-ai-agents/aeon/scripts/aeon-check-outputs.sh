#!/usr/bin/env bash
# aeon-check-outputs.sh - list commits touching outputs/ since a timestamp.
# Usage: aeon-check-outputs.sh [ISO-timestamp]   (default: 24 hours ago)
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
_aeon_load_config

SINCE_ISO="${1:-}"
if [[ -z "$SINCE_ISO" ]]; then
  SINCE_ISO="$(python3 -c "import datetime;print((datetime.datetime.utcnow()-datetime.timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
fi

_aeon_api GET "repos/$AEON_FORK_REPO/commits?path=outputs&since=$SINCE_ISO" | python3 -c "
import sys, json
for c in (json.load(sys.stdin) or []):
    sha = c.get('sha', '')[:7]
    date = c.get('commit', {}).get('author', {}).get('date', '')
    msg = c.get('commit', {}).get('message', '').split(chr(10))[0]
    print(f'{sha}  {date}  {msg}')
"
