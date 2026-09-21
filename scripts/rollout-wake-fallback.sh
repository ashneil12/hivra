#!/usr/bin/env bash
#
# rollout-wake-fallback.sh — patch EXISTING per-box Caddy vhosts fleet-wide
# with the hermes-auto-wake-fallback block (gateway auto-wake Phase 1).
#
# ⚠️  COMMITTED BUT NOT EXECUTED. Rolling this out mutates live host Caddy
#     configs and is a separate, supervised step. Run host-by-host, canary
#     (fixturenodea) first, with --dry-run before --execute.
#
# What it does, per host:
#   1. For every $CADDY_SITES_DIR/*.caddy vhost that does NOT already carry
#      the "hermes-auto-wake-fallback" marker:
#        a. Resolve the instance id for that vhost:
#             - from the --map CSV (gateway_host,instance_id) if provided —
#               export it from hermes_instances (id, hostname(gateway_url));
#             - else extracted from the vhost's forward_auth line
#               (…agent-stream-auth?instance_id=<uuid>…), present on all
#               webfree/dashboard-origin vhosts;
#             - else the vhost is SKIPPED (reported) — extend the map and rerun.
#        b. Back the file up to <file>.pre-wake-fallback.bak (once).
#        c. Insert the handle_errors block just inside the site's opening
#           brace, pointing at $WAKE_ORIGIN/wake/<instance_id>.
#   2. caddy validate. On failure: restore ALL backups taken this run and
#      exit non-zero (host left exactly as found).
#   3. Reload Caddy using the same direct-reload + auto-restart dance the
#      provisioner uses (reload panics must not leave ingress down).
#
# Idempotent: marker-guarded, reruns are no-ops for already-patched vhosts.
#
# Usage:
#   scripts/rollout-wake-fallback.sh [--map map.csv] [--wake-origin URL] \
#       [--sites-dir DIR] [--execute] <ssh-target> [<ssh-target>...]
#
#   ssh-target       e.g. root@203.0.113.x or a Host alias from ~/.ssh/config.
#                    Per-host keys: pass aliases configured with the right
#                    IdentityFile, or set SSH_OPTS="-i /path/to/key".
#   --map FILE       CSV "gateway_host,instance_id" (no header). Recommended:
#                    covers legacy vhosts that lack a forward_auth line.
#                      select gateway_url, id from hermes_instances
#                      where status != 'deleted' and gateway_url is not null;
#                    (strip scheme/path from gateway_url → bare hostname)
#   --wake-origin U  Default: https://hivra.cloud
#   --sites-dir D    Default: /etc/caddy/hermes.d
#   --dry-run        Default. Report what WOULD change; touch nothing.
#   --execute        Actually patch + validate + reload.
#
set -euo pipefail

WAKE_ORIGIN="https://hivra.cloud"
SITES_DIR="/etc/caddy/hermes.d"
MAP_FILE=""
EXECUTE=0
SSH_OPTS="${SSH_OPTS:-}"

HOSTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --map) MAP_FILE="$2"; shift 2 ;;
    --wake-origin) WAKE_ORIGIN="$2"; shift 2 ;;
    --sites-dir) SITES_DIR="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) HOSTS+=("$1"); shift ;;
  esac
done

if [ ${#HOSTS[@]} -eq 0 ]; then
  echo "usage: $0 [--map map.csv] [--wake-origin URL] [--execute] <ssh-target> [...]" >&2
  exit 2
fi

MAP_B64=""
if [ -n "$MAP_FILE" ]; then
  [ -r "$MAP_FILE" ] || { echo "map file not readable: $MAP_FILE" >&2; exit 2; }
  MAP_B64="$(base64 < "$MAP_FILE" | tr -d '\n')"
fi

for HOST in "${HOSTS[@]}"; do
  echo "=== $HOST (execute=$EXECUTE) ==="
  # shellcheck disable=SC2086
  ssh $SSH_OPTS "$HOST" \
    "WAKE_ORIGIN='$WAKE_ORIGIN' SITES_DIR='$SITES_DIR' EXECUTE='$EXECUTE' MAP_B64='$MAP_B64' bash -s" <<'REMOTE'
set -euo pipefail

MARKER="hermes-auto-wake-fallback"
MAP_TMP="$(mktemp)"
trap 'rm -f "$MAP_TMP"' EXIT
if [ -n "${MAP_B64:-}" ]; then
  printf '%s' "$MAP_B64" | base64 -d > "$MAP_TMP"
fi

lookup_map() { # $1 = gateway host → instance id or empty
  [ -s "$MAP_TMP" ] || { echo ""; return; }
  awk -F',' -v h="$1" 'tolower($1)==tolower(h) {gsub(/[[:space:]]/,"",$2); print $2; exit}' "$MAP_TMP"
}

extract_forward_auth_id() { # $1 = vhost file → instance id or empty
  grep -o 'agent-stream-auth?instance_id=[A-Za-z0-9-]*' "$1" 2>/dev/null \
    | head -1 | sed 's/.*instance_id=//'
}

build_block() { # $1 = wake url
  cat <<EOF
  # ${MARKER} v1 (fleet rollout): parked-VM 502s become a wake path instead
  # of a dead end. Browser navigations are redirected to the dashboard wake
  # page; non-browser clients (probes, API callers, reconcilers) get 503 +
  # Retry-After so status-code-driven tooling still sees a failure, not a 3xx.
  handle_errors {
    @wake_upstream_down expression {http.error.status_code} in [502, 503, 504]
    handle @wake_upstream_down {
      @wake_browser header Accept text/html*
      handle @wake_browser {
        redir $1 302
      }
      handle {
        header Retry-After "75"
        respond "Agent is parked. Wake it at $1" 503
      }
    }
  }
EOF
}

PATCHED=()
SKIPPED=0
CHANGED=0

restore_backups() {
  for f in "${PATCHED[@]}"; do
    [ -f "$f.pre-wake-fallback.bak" ] && cp "$f.pre-wake-fallback.bak" "$f"
  done
}

shopt -s nullglob
for f in "$SITES_DIR"/*.caddy; do
  if grep -q "$MARKER" "$f"; then
    continue
  fi
  ghost="$(basename "$f" .caddy)"
  id="$(lookup_map "$ghost")"
  if [ -z "$id" ]; then
    id="$(extract_forward_auth_id "$f")"
  fi
  if [ -z "$id" ]; then
    echo "SKIP  $ghost — no instance id (not in map, no forward_auth line)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  wake_url="$WAKE_ORIGIN/wake/$id"
  if [ "$EXECUTE" != "1" ]; then
    echo "WOULD $ghost -> $wake_url"
    CHANGED=$((CHANGED + 1))
    continue
  fi
  [ -f "$f.pre-wake-fallback.bak" ] || cp "$f" "$f.pre-wake-fallback.bak"
  # Insert the block immediately after the site's opening-brace line (the
  # first line ending in "{"). handle_errors placement inside the site block
  # is order-independent for Caddy; top keeps it visible. Passed via ENVIRON
  # (not awk -v) so mawk/gawk escape processing can't mangle the multi-line
  # value.
  WAKE_BLOCK="$(build_block "$wake_url")" \
  awk '
    { print }
    !done && /\{[[:space:]]*$/ { print ENVIRON["WAKE_BLOCK"]; done=1 }
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  PATCHED+=("$f")
  CHANGED=$((CHANGED + 1))
  echo "PATCH $ghost -> $wake_url"
done

echo "changed=$CHANGED skipped=$SKIPPED execute=$EXECUTE"

if [ "$EXECUTE" != "1" ] || [ ${#PATCHED[@]} -eq 0 ]; then
  exit 0
fi

# Validate with the daemon's resolved env (mirrors provisioning).
if command -v systemctl >/dev/null 2>&1; then
  for kv in $(systemctl show caddy -p Environment --value 2>/dev/null); do
    [ -n "$kv" ] && export "$kv"
  done
fi
if ! VALIDATE_ERR=$(caddy validate --config /etc/caddy/Caddyfile 2>&1); then
  echo "caddy validate FAILED — restoring backups" >&2
  printf '%s\n' "$VALIDATE_ERR" | tail -n 10 >&2
  restore_backups
  exit 1
fi

# Direct-reload + auto-restart dance (see hermes_caddy_reload in the
# provisioner): reload panics must not leave the host's ingress down.
if ! systemctl is-active caddy >/dev/null 2>&1; then
  systemctl reset-failed caddy >/dev/null 2>&1 || true
  systemctl start caddy
  exit $?
fi
for _ in 1 2 3; do
  if timeout 20s caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1; then
    echo "reloaded"
    exit 0
  fi
  if ! systemctl is-active caddy >/dev/null 2>&1; then
    systemctl reset-failed caddy >/dev/null 2>&1 || true
    systemctl start caddy
    exit $?
  fi
  sleep 2
done
echo "caddy reload failed after patching — investigate before proceeding" >&2
exit 1
REMOTE
done
