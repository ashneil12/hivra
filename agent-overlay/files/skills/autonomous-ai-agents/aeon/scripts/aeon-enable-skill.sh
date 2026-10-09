#!/usr/bin/env bash
# aeon-enable-skill.sh - enable a skill in aeon.yml and commit via the Contents API.
# Usage: aeon-enable-skill.sh <slug> <cron-string|workflow_dispatch>
set -euo pipefail
SLUG="${1:?Usage: aeon-enable-skill.sh <slug> <cron-string|workflow_dispatch>}"
SCHEDULE="${2:?Usage: aeon-enable-skill.sh <slug> <cron-string|workflow_dispatch>}"
source "$(dirname "$0")/_lib.sh"
_aeon_load_config

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

SHA="$(_aeon_api GET "repos/$AEON_FORK_REPO/contents/aeon.yml" | python3 -c "import sys,json;print(json.load(sys.stdin)['sha'])")"
_AEON_RAW=1 _aeon_api GET "repos/$AEON_FORK_REPO/contents/aeon.yml" > "$TMPDIR/aeon.yml"

SLUG="$SLUG" SCHEDULE="$SCHEDULE" SRC="$TMPDIR/aeon.yml" python3 <<'PY'
import os, re, pathlib, sys
p = pathlib.Path(os.environ["SRC"])
slug, schedule = os.environ["SLUG"], os.environ["SCHEDULE"]
text = p.read_text()
pattern = re.compile(r'^(\s+)' + re.escape(slug) + r':\s*\{[^}]*\}\s*(#.*)?$', re.MULTILINE)
m = pattern.search(text)
if not m:
    sys.exit(f"Skill '{slug}' not found in aeon.yml - check spelling against aeon-list-skills.sh")
indent, trailing = m.group(1), (m.group(2) or "")
suffix = f" {trailing}" if trailing else ""
new_line = f'{indent}{slug}: {{ enabled: true, schedule: "{schedule}" }}{suffix}'
text = pattern.sub(lambda _: new_line, text, count=1)
p.write_text(text)
PY

BODY="$(MSG="hermes: enable $SLUG (schedule: $SCHEDULE)" SRC="$TMPDIR/aeon.yml" SHA="$SHA" python3 -c "
import os, json, base64
content = base64.b64encode(open(os.environ['SRC'],'rb').read()).decode()
print(json.dumps({'message': os.environ['MSG'], 'content': content, 'sha': os.environ['SHA']}))")"

_aeon_api PUT "repos/$AEON_FORK_REPO/contents/aeon.yml" "$BODY" >/dev/null
echo "Enabled $SLUG with schedule: $SCHEDULE"
echo "See https://github.com/$AEON_FORK_REPO/actions"
