#!/usr/bin/env bash
# Read-only pre-flight for the no-fork move, one box. Runs as root ON the guest with $INST (instance id)
# and $DIR (/opt/hermes/instances/$INST) set, which is the contract of the fleet audit's --check-file
# (hivra-vm-side-rollout/scripts/audit-host.sh). The last line printed is PASS or FAIL:<why>.
# It changes nothing. The migration script runs the same checks itself and refuses safely; this is for
# the operator to learn BEFORE a wave which boxes will be refused and why.
set -u
INST="${INST:?}"; DIR="${DIR:-/opt/hermes/instances/$INST}"
fail() { echo "FAIL:$1"; exit 0; }
[ -d "$DIR" ] || fail "no instance dir"
[ -e "/var/lib/hermes-nofork-migrated-$INST" ] && { echo "PASS (already upstream)"; exit 0; }
G="agent-$INST-gateway"; D="agent-$INST-official-dashboard"
health() { docker inspect "$1" -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none; }
[ "$(health "$G")" = healthy ] || fail "gateway not healthy"
case "$(health "$D")" in healthy|none) ;; *) fail "dashboard container not healthy" ;; esac
n="$(grep -cE '^\s+image:\s*\S*vanilla-hermes-agent\S*$' "$DIR/docker-compose.yml" 2>/dev/null)"
[ "${n:-0}" -ge 2 ] || fail "compose has $n agent image lines (need the gateway and the dashboard)"
repos="$(grep -E '^\s+image:\s*\S*vanilla-hermes-agent\S*$' "$DIR/docker-compose.yml" | sed -E 's/^\s+image:\s*//; s/:[^:/]*$//' | sort -u | wc -l)"
[ "$repos" = 1 ] || fail "agent image lines name more than one repository"
[ -e "$DIR/docker-compose.override.yml" ] && fail "compose override present (read it before moving this box)"
free_kb="$(df --output=avail -k /var/lib/docker | tail -1 | tr -d ' ')"
[ "$free_kb" -ge $((12 * 1024 * 1024)) ] || fail "only $((free_kb / 1048576)) GB free; the move wants 12"
state="$(docker volume inspect "agent-${INST}_webui-state" -f '{{.Mountpoint}}' 2>/dev/null)"
[ -d "$state" ] || fail "state volume missing"
state_kb="$(du -sk --exclude=cache --exclude=.cache --exclude=hermes-agent "$state" 2>/dev/null | cut -f1)"
[ "$free_kb" -ge $((state_kb * 3 + 8 * 1024 * 1024)) ] || fail "state ($((state_kb / 1024)) MB) is too large for the free disk"
python3 - "$state/state.db" <<'PY' || fail "state.db is not readable or fails its integrity check"
import sqlite3, sys
c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=10)
sys.exit(0 if c.execute("pragma integrity_check").fetchone()[0] == "ok" else 1)
PY
[ -e "/var/lib/hermes-roll-paused-$INST" ] && fail "auto-roll is paused on this box (read why first)"
mark="/run/hermes-last-active-$INST"
[ -f "$mark" ] || fail "no idle marker (busy or never sampled)"
idle=$(( ( $(date +%s) - $(stat -c %Y "$mark") ) / 60 ))
[ "$idle" -ge 45 ] || fail "active $idle minutes ago (needs 45 idle)"
grep -qE '^HERMES_HOME=' "$DIR/.env" 2>/dev/null && ! grep -qE '^HERMES_HOME=/home/hermes/.hermes$' "$DIR/.env" && echo "note: stale HERMES_HOME line (the move removes it)"
echo PASS
