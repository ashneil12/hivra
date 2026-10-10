#!/usr/bin/env bash
# Build-time guard for the Hivra overlay image. Fails (exit 1) on any of:
#   1. an overlay file that would OVERWRITE a file in the stock upstream image (overlay must be add-only)
#   2. junk or non-UTF-8 python in files/ (macOS AppleDouble ._* files broke tool discovery once)
#   3. a runtime seam that does not apply to the upstream callables in this image (upstream drift)
#   4. uv / gh / hermes missing from the default PATH, or the version stamp unreadable
# Usage: scripts/check-overlay.sh <overlay-image> <upstream-image>
set -uo pipefail
OVERLAY=${1:?overlay image}; UPSTREAM=${2:?upstream image}
HERE=$(cd "$(dirname "$0")/.." && pwd)
fail=0; bad() { echo "FAIL $*"; fail=1; }

junk=$(find "$HERE/files" \( -name '._*' -o -name '.DS_Store' -o -name '__pycache__' \) | head -5)
[ -z "$junk" ] || bad "junk files in files/: $junk"
python3 - "$HERE/files" <<'PY' || fail=1
import pathlib, sys
bad = 0
for p in pathlib.Path(sys.argv[1]).rglob("*.py"):
    try: p.read_text(encoding="utf-8")
    except UnicodeDecodeError as e: print("FAIL non-utf8", p, e); bad = 1
sys.exit(bad)
PY

(cd "$HERE/files" && find . -type f | sed 's|^\./||') | docker run --rm -i --entrypoint sh "$UPSTREAM" -c \
  'n=0; while read -r f; do [ -e "/opt/hermes/$f" ] && { echo "FAIL collides with upstream file: $f"; n=1; }; done; exit $n' || fail=1

docker run --rm --entrypoint /opt/hermes/.venv/bin/python "$OVERLAY" -c '
import sys
from hivra_overlay import seams
res = seams.apply_all(only=list(seams.SEAMS))
print("seams:", res)
sys.exit(0 if all(v in ("applied", "already") for v in res.values()) else 1)' || bad "runtime seams do not apply to this upstream image"

docker run --rm --entrypoint sh "$OVERLAY" -c 'for c in uv gh hermes; do command -v $c >/dev/null || { echo "FAIL $c not on PATH"; exit 1; }; done; test -f /opt/hermes/install-stamp.json && grep -o "\"displayVersion\": \"[^\"]*\"" /opt/hermes/install-stamp.json' || fail=1

[ $fail = 0 ] && echo "OK overlay checks passed" || { echo "overlay checks FAILED"; exit 1; }
