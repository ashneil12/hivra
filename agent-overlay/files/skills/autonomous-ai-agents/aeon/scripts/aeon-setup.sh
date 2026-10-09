#!/usr/bin/env bash
# aeon-setup.sh - ensure the user has an Aeon fork (creating one via the GitHub
# REST API if needed) and wire its run-eligibility gate. gh-free: curl + the PAT.
# Resolution: recorded in config -> existing fork of aaronjmars/aeon -> fork it.
# Prints the owner/repo slug on stdout.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
_aeon_load_pat
command -v curl >/dev/null 2>&1 || { echo "curl not on PATH" >&2; exit 127; }

repo="$(_aeon_repo_from_config)"
[[ -z "$repo" ]] && repo="$(_aeon_discover_fork)"

if [[ -z "$repo" ]]; then
  echo "No Aeon fork found - forking aaronjmars/aeon into your account..." >&2
  _aeon_api POST "repos/aaronjmars/aeon/forks" '{}' >/dev/null 2>&1 || true
  # Forks are created asynchronously - poll briefly for it to appear.
  for _ in $(seq 1 15); do
    repo="$(_aeon_discover_fork)"; [[ -n "$repo" ]] && break
    sleep 2
  done
fi

[[ -z "$repo" ]] && { echo "Could not discover or create an Aeon fork." >&2; exit 1; }
_aeon_persist_repo "$repo"

# Inject the run-eligibility gate job into the fork's messages.yml scheduler if
# missing. Hermes owns the fork, so we add the gate ourselves rather than
# depending on upstream. Idempotent + safe: if upstream's structure ever drifts,
# the transform finds no anchor and leaves the file untouched (vars no-op).
_aeon_inject_gate() {
  local meta sha raw newyaml content body
  meta="$(_aeon_api GET "repos/$repo/contents/.github/workflows/messages.yml" 2>/dev/null)" || return 1
  sha="$(printf '%s' "$meta" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sha',''))")"
  raw="$(printf '%s' "$meta" | python3 -c "import sys,json,base64;print(base64.b64decode(json.load(sys.stdin).get('content','')).decode())")"
  [[ -z "$sha" || -z "$raw" ]] && return 1
  if printf '%s' "$raw" | grep -q "Check HermesOS instance eligibility"; then
    return 0  # already gated
  fi
  newyaml="$(printf '%s' "$raw" | python3 - <<'PY'
import sys, re
text = sys.stdin.read()
pat = re.compile(
    r"^jobs:\n  tick:\n    if: (.+)\n    runs-on: ubuntu-latest\n    timeout-minutes: 5$",
    re.MULTILINE,
)
m = pat.search(text)
if not m:
    sys.stdout.write(text)  # structure changed -> leave untouched (safe no-op)
    sys.exit(0)
cond = m.group(1)
gate = (
    "jobs:\n"
    "  gate:\n"
    f"    if: {cond}\n"
    "    runs-on: ubuntu-latest\n"
    "    timeout-minutes: 2\n"
    "    outputs:\n"
    "      active: ${{ steps.check.outputs.active }}\n"
    "    steps:\n"
    "      - name: Check HermesOS instance eligibility\n"
    "        id: check\n"
    "        env:\n"
    "          GATE_URL: ${{ vars.HERMES_AEON_GATE_URL }}\n"
    "          INSTANCE_ID: ${{ vars.HERMES_INSTANCE_ID }}\n"
    "        run: |\n"
    '          if [ -z "$GATE_URL" ] || [ -z "$INSTANCE_ID" ]; then echo "active=true" >> "$GITHUB_OUTPUT"; exit 0; fi\n'
    '          code=$(curl -s -m 15 -o ${TMPDIR:-/tmp}/gate.json -w "%{http_code}" "$GATE_URL/api/instances/$INSTANCE_ID/aeon-gate" || echo 000)\n'
    "          active=$(jq -r 'if .active == true then \"true\" else \"false\" end' ${TMPDIR:-/tmp}/gate.json 2>/dev/null || echo \"false\")\n"
    '          if [ "$code" = "200" ] && [ "$active" = "true" ]; then echo "active=true" >> "$GITHUB_OUTPUT"; else echo "active=false" >> "$GITHUB_OUTPUT"; fi\n'
    "\n"
    "  tick:\n"
    "    needs: gate\n"
    "    if: needs.gate.outputs.active == 'true'\n"
    "    runs-on: ubuntu-latest\n"
    "    timeout-minutes: 5"
)
sys.stdout.write(text[:m.start()] + gate + text[m.end():])
PY
)"
  printf '%s' "$newyaml" | grep -q "Check HermesOS instance eligibility" || return 1  # anchor not found
  content="$(printf '%s' "$newyaml" | base64 | tr -d '\n')"
  body="$(MSG='hermes: add run-eligibility gate' CONTENT="$content" SHA="$sha" python3 -c "import os,json;print(json.dumps({'message':os.environ['MSG'],'content':os.environ['CONTENT'],'sha':os.environ['SHA']}))")"
  _aeon_api PUT "repos/$repo/contents/.github/workflows/messages.yml" "$body" >/dev/null 2>&1
}

# --- Wire the run-eligibility gate (best-effort) ---------------------------
# The dashboard injects HERMES_INSTANCE_ID + HERMES_AEON_GATE_URL into this
# container. Set them as repo variables AND ensure the gate job exists, so the
# fork skips scheduled work whenever the dashboard reports the instance inactive.
if [[ -n "${HERMES_INSTANCE_ID:-}" && -n "${HERMES_AEON_GATE_URL:-}" ]]; then
  _aeon_set_var() {  # create-or-update an Actions variable
    local name="$1" val="$2" body
    body="$(NAME="$name" VAL="$val" python3 -c "import os,json;print(json.dumps({'name':os.environ['NAME'],'value':os.environ['VAL']}))")"
    _aeon_api POST "repos/$repo/actions/variables" "$body" >/dev/null 2>&1 \
      || _aeon_api PATCH "repos/$repo/actions/variables/$name" "$body" >/dev/null 2>&1
  }
  if _aeon_set_var HERMES_AEON_GATE_URL "$HERMES_AEON_GATE_URL" \
     && _aeon_set_var HERMES_INSTANCE_ID "$HERMES_INSTANCE_ID"; then
    if _aeon_inject_gate; then
      echo "Run-eligibility gate wired (instance $HERMES_INSTANCE_ID)." >&2
    else
      echo "Gate vars set, but the gate job wasn't injected (upstream YAML drift?) - vars are harmless no-ops." >&2
    fi
  else
    echo "WARN: could not set gate repo variables. Scheduled runs won't be pause-gated." >&2
  fi
fi

echo "$repo"
{
  echo "Aeon fork ready: $repo"
  echo "NOTE: a freshly forked Aeon needs ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)"
  echo "      + a notification channel (Telegram/Discord/Slack) as Actions secrets before"
  echo "      scheduled runs work. Confirm with the user before the first autonomous run."
} >&2
