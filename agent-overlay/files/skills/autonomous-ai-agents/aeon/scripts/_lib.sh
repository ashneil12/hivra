# _lib.sh - shared helpers for the aeon skill. Source this; don't execute it.
#
# gh-free: the GitHub CLI is NOT installed in the agent image, so everything
# talks to the GitHub REST API directly with curl + the PAT from config.yaml
# (skills.config.aeon_github_pat). curl + python3 are always present. The fork
# repo is resolved from config, else auto-discovered; created only by
# aeon-setup.sh. Env vars (AEON_PAT / AEON_FORK_REPO) win, for testing.

_aeon_cfg_path() { echo "${HERMES_HOME:-$HOME/.hermes}/config.yaml"; }

# Load AEON_PAT from config.yaml (required). Exits non-zero with a message.
_aeon_load_pat() {
  [[ -n "${AEON_PAT:-}" ]] && { export AEON_PAT; return 0; }
  command -v python3 >/dev/null 2>&1 || { echo "python3 not on PATH" >&2; return 127; }
  AEON_PAT="$(CFG="$(_aeon_cfg_path)" python3 - <<'PY'
import os, sys
try:
    import yaml
    with open(os.environ["CFG"]) as fh:
        data = yaml.safe_load(fh) or {}
except Exception:
    sys.exit(0)
sc = (((data.get("skills") or {}).get("config")) or {})
print(str(sc.get("aeon_github_pat") or ""))
PY
)"
  if [[ -z "${AEON_PAT:-}" ]]; then
    echo "AEON not configured. Paste a GitHub token in Settings -> AEON." >&2
    return 1
  fi
  export AEON_PAT
}

# GitHub REST call. Usage: _aeon_api METHOD PATH [JSON_BODY]
# Set _AEON_RAW=1 to receive a file's raw bytes (contents API). Returns curl's
# exit status (non-zero on HTTP >=400, since -f is set).
_aeon_api() {
  local method="$1" path="$2" body="${3:-}"
  command -v curl >/dev/null 2>&1 || { echo "curl not on PATH" >&2; return 127; }
  local accept="application/vnd.github+json"
  [[ "${_AEON_RAW:-}" == "1" ]] && accept="application/vnd.github.raw"
  local url="https://api.github.com/${path#/}"
  local args=(-fsSL -X "$method"
    -H "Authorization: Bearer $AEON_PAT"
    -H "Accept: $accept"
    -H "X-GitHub-Api-Version: 2022-11-28")
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}" "$url"
}

# Authenticated user's login.
_aeon_username() {
  _aeon_api GET user 2>/dev/null | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('login',''))
except Exception: print('')"
}

# Read the recorded fork repo from config.yaml (may be empty).
_aeon_repo_from_config() {
  command -v python3 >/dev/null 2>&1 || return 0
  CFG="$(_aeon_cfg_path)" python3 - <<'PY'
import os, sys
try:
    import yaml
    with open(os.environ["CFG"]) as fh:
        data = yaml.safe_load(fh) or {}
except Exception:
    sys.exit(0)
sc = (((data.get("skills") or {}).get("config")) or {})
print(str(sc.get("aeon_fork_repo") or ""))
PY
}

# Discover the user's existing fork of aaronjmars/aeon (checks <user>/aeon is a
# fork of it). Echoes owner/repo or nothing.
_aeon_discover_fork() {
  local user; user="$(_aeon_username)"
  [[ -z "$user" ]] && { echo ""; return 0; }
  _aeon_api GET "repos/$user/aeon" 2>/dev/null | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
print(d.get('full_name','') if d.get('fork') and (d.get('parent') or {}).get('full_name')=='aaronjmars/aeon' else '')"
}

# Persist the resolved repo into config.yaml so later calls + the WebUI see it.
_aeon_persist_repo() {
  local repo="${1:-}"; [[ -z "$repo" ]] && return 0
  command -v python3 >/dev/null 2>&1 || return 0
  CFG="$(_aeon_cfg_path)" REPO="$repo" python3 - <<'PY'
import os
try:
    import yaml
except Exception:
    raise SystemExit(0)
cfg = os.environ["CFG"]
try:
    with open(cfg) as fh:
        data = yaml.safe_load(fh) or {}
except FileNotFoundError:
    data = {}
except Exception:
    raise SystemExit(0)
data.setdefault("skills", {}).setdefault("config", {})["aeon_fork_repo"] = os.environ["REPO"]
try:
    with open(cfg, "w") as fh:
        yaml.safe_dump(data, fh, default_flow_style=False, sort_keys=False)
except Exception:
    raise SystemExit(0)
PY
}

# For read/invoke scripts: ensure AEON_PAT + an EXISTING fork (config or
# discovered). Never creates - points at aeon-setup.sh when none exists.
_aeon_load_config() {
  _aeon_load_pat || return $?
  command -v curl >/dev/null 2>&1 || { echo "curl not on PATH" >&2; return 127; }
  [[ -z "${AEON_FORK_REPO:-}" ]] && AEON_FORK_REPO="$(_aeon_repo_from_config)"
  if [[ -z "${AEON_FORK_REPO:-}" ]]; then
    AEON_FORK_REPO="$(_aeon_discover_fork)"
    [[ -n "${AEON_FORK_REPO:-}" ]] && _aeon_persist_repo "$AEON_FORK_REPO"
  fi
  if [[ -z "${AEON_FORK_REPO:-}" ]]; then
    echo "No Aeon fork found for this account yet. Run: bash scripts/aeon-setup.sh" >&2
    return 1
  fi
  export AEON_PAT AEON_FORK_REPO
}
